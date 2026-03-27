import fs from 'fs/promises'
import path from 'path'

import Logger from '@home-gallery/logger'
import {
  appendMediaStateEvent,
  disableMissingNextcloudMediaEntries,
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
    source.nextcloudDiscovery = {
      taggedTargetCount: tagTargets.length,
      fileCandidateCount: fileCandidates.length,
      disabledMissingCount: disabledRows.length
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
