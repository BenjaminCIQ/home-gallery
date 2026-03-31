import fs from 'fs/promises'
import path from 'path'

import Logger from '@home-gallery/logger'
import {
  appendMediaStateEvent,
  disableMissingNextcloudMediaEntries,
  listActiveNextcloudMediaEntries,
  reenableEligibleNextcloudMediaEntries,
  replaceMediaStateTagSnapshot,
  upsertMediaStateEntries
} from './media-state-db.js'
import {
  discoverNextcloudTaggedFiles,
  discoverNextcloudTagTargets,
  NEXTCLOUD_RECONCILE_SKIP_PREFIX,
  stripNamedFolderFromDiscoveryRow
} from './nextcloud-discovery.js'

const log = Logger('cli.task.nextcloudProjection')

const sanitizeForPath = value => (value || '')
  .toString()
  .trim()
  .replace(/[^A-Za-z0-9._-]/g, '_')

const getDefaultProjectionSubdir = (source, i) => {
  const preferred = source.projectionSubdir || source.name || path.basename(source.index || '') || `source_${i}`
  return sanitizeForPath(preferred) || `source_${i}`
}

const isNextcloudTagSource = source => source?.type === 'nextcloud_tag'
const buildEntryId = (sourceRef, filePath) => `${sourceRef}:${filePath}`
const buildFingerprint = row => `nextcloud:${row.target_file_id || row.target_path}:${row.etag || ''}`
const normalizeRelativePath = relPath => relPath.replace(/\\/g, '/').replace(/^\/+/, '')
const isWithinRoot = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`)

const listFilesRecursive = async rootDir => {
  const out = []
  const walk = async currentDir => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(abs)
      }
    }
  }
  await walk(rootDir)
  return out
}

const removeEmptyDirsRecursive = async rootDir => {
  const walk = async currentDir => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await walk(path.join(currentDir, entry.name))
      }
    }
    const after = await fs.readdir(currentDir).catch(() => [])
    if (!after.length && currentDir !== rootDir) {
      await fs.rmdir(currentDir).catch(() => false)
    }
  }
  await walk(rootDir)
}

const fileSignature = stat => `${stat.size}:${Math.floor(stat.mtimeMs)}`

const resolveSymlinkTarget = async targetPath => {
  const linkPath = await fs.readlink(targetPath)
  if (path.isAbsolute(linkPath)) {
    return path.normalize(linkPath)
  }
  return path.normalize(path.resolve(path.dirname(targetPath), linkPath))
}

const isTargetUpToDate = async ({ mode, sourcePath, sourceStat, targetPath }) => {
  const targetLstat = await fs.lstat(targetPath).catch(() => null)
  if (!targetLstat) {
    return false
  }
  if (mode === 'copy') {
    if (!targetLstat.isFile()) {
      return false
    }
    const targetStat = await fs.stat(targetPath).catch(() => null)
    return !!targetStat && fileSignature(targetStat) === fileSignature(sourceStat)
  }

  if (targetLstat.isSymbolicLink()) {
    const targetRef = await resolveSymlinkTarget(targetPath).catch(() => null)
    return targetRef === path.normalize(sourcePath)
  }
  if (mode === 'link') {
    return false
  }
  if (!targetLstat.isFile()) {
    return false
  }
  const targetStat = await fs.stat(targetPath).catch(() => null)
  return !!targetStat && fileSignature(targetStat) === fileSignature(sourceStat)
}

const replaceFileAtomic = async (tempPath, targetPath) => {
  await fs.rename(tempPath, targetPath)
}

const materializeFile = async ({ mode, sourcePath, sourceStat, targetPath }) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const targetExists = !!(await fs.lstat(targetPath).catch(() => null))
  if (await isTargetUpToDate({ mode, sourcePath, sourceStat, targetPath })) {
    return { status: 'unchanged' }
  }
  const tempPath = `${targetPath}.tmp-hg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  if (mode === 'copy') {
    await fs.copyFile(sourcePath, tempPath)
    await replaceFileAtomic(tempPath, targetPath)
    return { status: targetExists ? 'updated' : 'created' }
  }
  try {
    await fs.symlink(sourcePath, tempPath, 'file')
    await replaceFileAtomic(tempPath, targetPath)
    return { status: targetExists ? 'updated' : 'created' }
  } catch (err) {
    await fs.unlink(tempPath).catch(() => false)
    if (mode === 'link') {
      throw err
    }
    await fs.copyFile(sourcePath, tempPath)
    await replaceFileAtomic(tempPath, targetPath)
    return { status: targetExists ? 'updated' : 'created' }
  }
}

const applyProjectionMaterialization = async ({ source, sourceDir, sourceRef, mode, dbPath }) => {
  const localRoot = source.nextcloudLocalRoot
  if (!localRoot) {
    throw new Error(`Source '${sourceRef}' requires local dir for projection materialization`)
  }

  const activeRows = listActiveNextcloudMediaEntries(dbPath, sourceRef, source.tag)
  const expectedTargets = new Set()
  let materializedCount = 0
  let createdCount = 0
  let updatedCount = 0
  let unchangedCount = 0

  for (const row of activeRows) {
    const relPath = normalizeRelativePath(row.file_path)
    const sourcePath = path.resolve(localRoot, relPath)
    const targetPath = path.resolve(sourceDir, relPath)

    if (!isWithinRoot(path.resolve(localRoot), sourcePath) || !isWithinRoot(path.resolve(sourceDir), targetPath)) {
      log.warn(`Skip unsafe projection path for ${sourceRef}: ${row.file_path}`)
      appendMediaStateEvent(dbPath, {
        event_type: 'nextcloud_projection_unsafe_path',
        source_type: 'nextcloud_tag',
        source_ref: sourceRef,
        file_path: row.file_path,
        reason: `sourcePath:${sourcePath} targetPath:${targetPath}`
      })
      continue
    }
    expectedTargets.add(targetPath)

    const sourceStat = await fs.stat(sourcePath).catch(() => false)
    if (!sourceStat || !sourceStat.isFile()) {
      log.warn(`Skip projection of missing local file '${sourcePath}' for '${sourceRef}'`)
      appendMediaStateEvent(dbPath, {
        event_type: 'nextcloud_projection_missing_local_file',
        source_type: 'nextcloud_tag',
        source_ref: sourceRef,
        file_path: row.file_path,
        reason: `expectedLocalFile:${sourcePath}`
      })
      continue
    }

    try {
      const result = await materializeFile({
        mode,
        sourcePath,
        sourceStat,
        targetPath
      })
      if (result.status === 'unchanged') {
        unchangedCount += 1
      } else {
        materializedCount += 1
        if (result.status === 'created') {
          createdCount += 1
        } else {
          updatedCount += 1
        }
      }
    } catch (err) {
      log.warn(err, `Projection materialize failed for '${sourceRef}' ${row.file_path}`)
      appendMediaStateEvent(dbPath, {
        event_type: 'nextcloud_projection_materialize_failed',
        source_type: 'nextcloud_tag',
        source_ref: sourceRef,
        file_path: row.file_path,
        reason: `${err?.message || String(err)} target:${targetPath}`
      })
    }
  }

  const existingProjected = await listFilesRecursive(sourceDir)
  let removedCount = 0
  for (const file of existingProjected) {
    if (!expectedTargets.has(file)) {
      await fs.unlink(file).catch(() => false)
      removedCount += 1
    }
  }
  await removeEmptyDirsRecursive(sourceDir)

  appendMediaStateEvent(dbPath, {
    event_type: 'nextcloud_projection_materialize',
    source_type: 'nextcloud_tag',
    source_ref: sourceRef,
    reason: `materialized:${materializedCount},created:${createdCount},updated:${updatedCount},unchanged:${unchangedCount},removed:${removedCount},active:${activeRows.length}`
  })

  return {
    activeCount: activeRows.length,
    materializedCount,
    createdCount,
    updatedCount,
    unchangedCount,
    removedCount
  }
}

export const reconcileProjectionSources = async (sources, options = {}) => {
  const nextcloudSources = (sources || []).filter(isNextcloudTagSource)
  if (!nextcloudSources.length) {
    return sources
  }

  const projectionRoot = options?.config?.nextcloudProjection?.root
  if (!projectionRoot) {
    throw new Error(`nextcloudProjection.root is required for nextcloud_tag sources`)
  }

  await fs.mkdir(projectionRoot, { recursive: true })
  for (const [i, source] of sources.entries()) {
    if (!isNextcloudTagSource(source)) {
      continue
    }

    source.nextcloudLocalRoot = source.localDir
    if (!source.nextcloudLocalRoot) {
      throw new Error(`nextcloud_tag source '${source.name || source.index}' requires localDir`)
    }
    const projectionSubdir = getDefaultProjectionSubdir(source, i)
    const sourceDir = path.resolve(projectionRoot, projectionSubdir)
    await fs.mkdir(sourceDir, { recursive: true })

    source.projectionSubdir = projectionSubdir
    source.dir = sourceDir
    if (!source.materializationMode) {
      source.materializationMode = options?.config?.nextcloudProjection?.materializationMode || 'auto'
    }

    const sourceRef = source.name || source.index
    try {
      const tagTargets = await discoverNextcloudTagTargets(source, options?.config)
      const tagSnapshotRows = source.namedFolder
        ? tagTargets.map(row => stripNamedFolderFromDiscoveryRow(row, source.namedFolder))
        : tagTargets
      replaceMediaStateTagSnapshot(options?.config?.mediaState?.dbPath, source.tag, tagSnapshotRows)
      const fileCandidates = await discoverNextcloudTaggedFiles(source, options?.config, tagTargets)
      const candidateEntries = fileCandidates.map(row => ({
        entry_id: buildEntryId(sourceRef, row.target_path),
        source_type: 'nextcloud_tag',
        source_ref: sourceRef,
        file_path: row.target_path,
        file_fingerprint: buildFingerprint(row),
        target_file_id: row.target_file_id || null,
        origin_tag: source.tag,
        origin_mode: row.origin_mode,
        origin_folder_path: row.origin_folder_path,
        state: 'active'
      }))
      upsertMediaStateEntries(options?.config?.mediaState?.dbPath, candidateEntries)
      const reenabledRows = reenableEligibleNextcloudMediaEntries(
        options?.config?.mediaState?.dbPath,
        sourceRef,
        source.tag,
        candidateEntries
      )
      const seenFingerprints = fileCandidates.map(buildFingerprint)
      const disabledRows = disableMissingNextcloudMediaEntries(
        options?.config?.mediaState?.dbPath,
        sourceRef,
        source.tag,
        seenFingerprints
      )
      const projection = await applyProjectionMaterialization({
        source,
        sourceDir,
        sourceRef,
        mode: source.materializationMode,
        dbPath: options?.config?.mediaState?.dbPath
      })
      source.nextcloudDiscovery = {
        taggedTargetCount: tagTargets.length,
        fileCandidateCount: fileCandidates.length,
        disabledMissingCount: disabledRows.length,
        reenabledCount: reenabledRows.length,
        materializedCount: projection.materializedCount,
        removedProjectedCount: projection.removedCount
      }
      appendMediaStateEvent(options?.config?.mediaState?.dbPath, {
        event_type: 'nextcloud_discovery',
        source_type: 'nextcloud_tag',
        source_ref: sourceRef,
        reason: `tagged_targets:${tagTargets.length},file_candidates:${fileCandidates.length},disabled_missing:${disabledRows.length},reenabled:${reenabledRows.length}`
      })
    } catch (err) {
      const msg = String(err?.message || err)
      if (msg.startsWith(NEXTCLOUD_RECONCILE_SKIP_PREFIX)) {
        log.warn(`Skipping nextcloud reconcile for '${source.name || source.index}': ${msg}`)
        appendMediaStateEvent(options?.config?.mediaState?.dbPath, {
          event_type: 'nextcloud_reconcile_skipped',
          source_type: 'nextcloud_tag',
          source_ref: sourceRef,
          reason: msg
        })
        source.nextcloudDiscovery = { skipped: true, skipReason: msg }
        log.debug(`Prepared nextcloud projection source '${source.name || source.index}' at ${sourceDir} (${source.materializationMode})`)
        continue
      }
      throw err
    }

    log.debug(`Prepared nextcloud projection source '${source.name || source.index}' at ${sourceDir} (${source.materializationMode})`)
  }

  return sources
}
