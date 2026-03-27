import fs from 'fs/promises'
import path from 'path'

import Logger from '@home-gallery/logger'
import {
  appendMediaStateEvent,
  disableMissingNextcloudMediaEntries,
  listActiveNextcloudMediaEntries,
  replaceMediaStateTagSnapshot,
  upsertMediaStateEntries
} from './media-state-db.js'
import { discoverNextcloudTaggedFiles, discoverNextcloudTagTargets } from './nextcloud-discovery.js'

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
      } else if (entry.isFile()) {
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

const materializeFile = async ({ mode, sourcePath, targetPath }) => {
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.unlink(targetPath).catch(() => false)
  if (mode === 'copy') {
    await fs.copyFile(sourcePath, targetPath)
    return
  }
  try {
    await fs.symlink(sourcePath, targetPath, 'file')
  } catch (err) {
    if (mode === 'link') {
      throw err
    }
    await fs.copyFile(sourcePath, targetPath)
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

  for (const row of activeRows) {
    const relPath = normalizeRelativePath(row.file_path)
    const sourcePath = path.resolve(localRoot, relPath)
    const targetPath = path.resolve(sourceDir, relPath)

    if (!isWithinRoot(path.resolve(localRoot), sourcePath) || !isWithinRoot(path.resolve(sourceDir), targetPath)) {
      log.warn(`Skip unsafe projection path for ${sourceRef}: ${row.file_path}`)
      continue
    }
    expectedTargets.add(targetPath)

    const sourceStat = await fs.stat(sourcePath).catch(() => false)
    if (!sourceStat || !sourceStat.isFile()) {
      log.warn(`Skip projection of missing local file '${sourcePath}' for '${sourceRef}'`)
      continue
    }

    await materializeFile({
      mode,
      sourcePath,
      targetPath
    })
    materializedCount += 1
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
    reason: `materialized:${materializedCount},removed:${removedCount},active:${activeRows.length}`
  })

  return {
    activeCount: activeRows.length,
    materializedCount,
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

    source.nextcloudLocalRoot = source.nextcloudLocalRoot || source.localDir || source.dir
    const projectionSubdir = getDefaultProjectionSubdir(source, i)
    const sourceDir = path.resolve(projectionRoot, projectionSubdir)
    await fs.mkdir(sourceDir, { recursive: true })

    source.projectionSubdir = projectionSubdir
    source.dir = sourceDir
    if (!source.materializationMode) {
      source.materializationMode = options?.config?.nextcloudProjection?.materializationMode || 'auto'
    }

    const tagTargets = await discoverNextcloudTagTargets(source, options?.config)
    replaceMediaStateTagSnapshot(options?.config?.mediaState?.dbPath, source.tag, tagTargets)
    const fileCandidates = await discoverNextcloudTaggedFiles(source, options?.config, tagTargets)
    const sourceRef = source.name || source.index
    upsertMediaStateEntries(options?.config?.mediaState?.dbPath, fileCandidates.map(row => ({
      entry_id: buildEntryId(sourceRef, row.target_path),
      source_type: 'nextcloud_tag',
      source_ref: sourceRef,
      file_path: row.target_path,
      file_fingerprint: buildFingerprint(row),
      origin_tag: source.tag,
      origin_mode: row.origin_mode,
      origin_folder_path: row.origin_folder_path,
      state: 'active'
    })))
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
      materializedCount: projection.materializedCount,
      removedProjectedCount: projection.removedCount
    }
    appendMediaStateEvent(options?.config?.mediaState?.dbPath, {
      event_type: 'nextcloud_discovery',
      source_type: 'nextcloud_tag',
      source_ref: sourceRef,
      reason: `tagged_targets:${tagTargets.length},file_candidates:${fileCandidates.length},disabled_missing:${disabledRows.length}`
    })

    log.debug(`Prepared nextcloud projection source '${source.name || source.index}' at ${sourceDir} (${source.materializationMode})`)
  }

  return sources
}
