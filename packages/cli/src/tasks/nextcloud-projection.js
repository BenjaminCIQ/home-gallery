import fs from 'fs/promises'
import path from 'path'

import Logger from '@home-gallery/logger'
import { appendMediaStateEvent, replaceMediaStateTagSnapshot } from './media-state-db.js'
import { discoverNextcloudTagTargets } from './nextcloud-discovery.js'

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
    source.nextcloudDiscovery = { taggedTargetCount: tagTargets.length }
    appendMediaStateEvent(options?.config?.mediaState?.dbPath, {
      event_type: 'nextcloud_discovery',
      source_type: 'nextcloud_tag',
      source_ref: source.name || source.index,
      reason: `tagged_targets:${tagTargets.length}`
    })

    log.debug(`Prepared nextcloud projection source '${source.name || source.index}' at ${sourceDir} (${source.materializationMode})`)
  }

  return sources
}
