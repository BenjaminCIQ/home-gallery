import fs from 'fs/promises'
import path from 'path'

import Logger from '@home-gallery/logger'

const log = Logger('cli.task.nextcloudProjection')

const sanitizeForPath = value => (value || '')
  .toString()
  .trim()
  .replace(/[^A-Za-z0-9._-]/g, '_')

const getDefaultStagingSubdir = (source, i) => {
  const preferred = source.stagingSubdir || source.name || path.basename(source.index || '') || `source_${i}`
  return sanitizeForPath(preferred) || `source_${i}`
}

const isNextcloudTagSource = source => source?.type === 'nextcloud_tag'

export const reconcileProjectionSources = async (sources, options = {}) => {
  const nextcloudSources = (sources || []).filter(isNextcloudTagSource)
  if (!nextcloudSources.length) {
    return sources
  }

  const stagingRoot = options?.config?.nextcloudProjection?.stagingRoot
  if (!stagingRoot) {
    throw new Error(`nextcloudProjection.stagingRoot is required for nextcloud_tag sources`)
  }

  await fs.mkdir(stagingRoot, { recursive: true })
  for (const [i, source] of sources.entries()) {
    if (!isNextcloudTagSource(source)) {
      continue
    }

    const stagingSubdir = getDefaultStagingSubdir(source, i)
    const sourceDir = path.resolve(stagingRoot, stagingSubdir)
    await fs.mkdir(sourceDir, { recursive: true })

    source.stagingSubdir = stagingSubdir
    source.dir = sourceDir
    if (!source.materializationMode) {
      source.materializationMode = options?.config?.nextcloudProjection?.materializationMode || 'auto'
    }

    log.debug(`Prepared nextcloud projection source '${source.name || source.index}' at ${sourceDir} (${source.materializationMode})`)
  }

  return sources
}
