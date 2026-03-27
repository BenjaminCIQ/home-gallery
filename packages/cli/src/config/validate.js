import fs from 'fs/promises'

import Logger from '@home-gallery/logger'

const log = Logger('cli.config.validate')

const assertError = (message, ...args) => { throw new Error(message, ...args) };

const isNextcloudTagSource = source => source?.type === 'nextcloud_tag'
const isLocalSource = source => !source?.type || source.type === 'local_folder'

const validateSources = async sources => {
  if (!sources || !sources.length) {
    log.warn(`Sources list is empty`)
    return
  }

  const onlineSources = sources.filter(source => !source.offline && isLocalSource(source))
  for (const i in onlineSources) {
    const source = onlineSources[i];
    const dirStat = await fs.stat(source.dir).catch(() => false);
    dirStat || assertError(`Source directory '${source.dir}' does not exists and is required for an online source.`)
    dirStat.isDirectory() || assertError(`Source directory '${source.dir}' is not a directory`)
  }

  const offlineSources = sources.filter(source => source.offline)
  for (const i in offlineSources) {
    const source = offlineSources[i];
    const fileStat = await fs.stat(source.index).catch(() => false);
    fileStat || assertError(`Index file ${source.index} of offline source directory '${source.dir}' does not exists. Offline sources require an index file and you should process a source first before it can be marked offline`)
    fileStat.isFile() || assertError(`Index file ${source.index} of offline source directory '${source.dir}' is not a file`)
  }

  const uniqIndexFiles = sources.map(source => source.index).filter((v, i, a) => a.indexOf(v) === i);
  (uniqIndexFiles.length == sources.length) || assertError(`Source index files are not unique`);
}

const validateNextcloudProjection = (config, sources) => {
  const nextcloudSources = (sources || []).filter(isNextcloudTagSource)
  if (!nextcloudSources.length) {
    return
  }

  config.nextcloud?.baseUrl || assertError(`nextcloud.baseUrl is required when nextcloud_tag sources are configured`)
  config.nextcloud?.username || assertError(`nextcloud.username is required when nextcloud_tag sources are configured`)
  config.nextcloud?.appPassword || assertError(`nextcloud.appPassword is required when nextcloud_tag sources are configured`)
  config.nextcloudProjection?.root || assertError(`nextcloudProjection.root is required when nextcloud_tag sources are configured`)

  for (const source of nextcloudSources) {
    source.tag || assertError(`Source '${source.name || source.index}' with type nextcloud_tag requires 'tag'`)
  }
}

const validateRemovalPolicy = config => {
  const globalPolicy = config.mediaState?.localRemovalPolicy || 'trash'
  const globalTrashPath = config.mediaState?.localTrashPath
  const sources = config.sources || []

  if (globalPolicy === 'trash' && !globalTrashPath) {
    assertError(`mediaState.localTrashPath is required when mediaState.localRemovalPolicy is 'trash'`)
  }

  for (const source of sources) {
    if (!isLocalSource(source)) {
      continue
    }
    const policy = source.onRemoveFromFrame || globalPolicy
    const trashPath = source.trashPath || globalTrashPath
    if (policy === 'trash' && !trashPath) {
      assertError(`Source '${source.name || source.dir || source.index}' requires trashPath or mediaState.localTrashPath when onRemoveFromFrame is 'trash'`)
    }
  }
}

export const validateConfig = async config => {
  await validateSources(config.sources)
  validateNextcloudProjection(config, config.sources)
  validateRemovalPolicy(config)
}
