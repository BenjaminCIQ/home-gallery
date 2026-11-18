import fs from 'fs'
import path from 'path'

import Logger from '@home-gallery/logger'

import { matchSourceByDirectoryPrefix, getNextcloudProjectionDir } from './gallery-media-state-resolve.js'

const log = Logger('server.api.database.removeFromFrame')

const hasRemoveFromFrame = event => (event?.actions || []).some(a => a.action === 'removeFromFrame')

const uniqueDestPath = (dir, baseName) => {
  let dest = path.join(dir, baseName)
  if (!fs.existsSync(dest)) {
    return dest
  }
  const { name, ext } = path.parse(baseName)
  let i = 1
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${name}_${i}${ext}`)
    i += 1
  }
  return dest
}

const moveToTrash = (abs, destDir) => {
  fs.mkdirSync(destDir, { recursive: true })
  const dest = uniqueDestPath(destDir, path.basename(abs))
  try {
    fs.renameSync(abs, dest)
  } catch (err) {
    if (err.code !== 'EXDEV') {
      throw err
    }
    // cross-device: only remove the source after a successful copy
    fs.copyFileSync(abs, dest, fs.constants.COPYFILE_EXCL)
    fs.unlinkSync(abs)
  }
}

// Nextcloud projection: only ever unlink the frame link, never an original
const removeProjectionLink = (abs, source, config) => {
  const projDir = getNextcloudProjectionDir(source, config)
  const root = projDir || path.resolve(source.dir)
  if (!abs.startsWith(root + path.sep)) {
    log.warn(`removeFromFrame: ${abs} is outside projection root ${root}, skip`)
    return
  }
  const st = fs.lstatSync(abs)
  if (!st.isSymbolicLink() && source.materializationMode !== 'copy') {
    log.warn(`removeFromFrame: ${abs} is not a symlink, skip`)
    return
  }
  fs.unlinkSync(abs)
  log.info(`removeFromFrame: ${abs} removed from frame (link only, original kept)`)
}

const removeFile = (config, entry, fp) => {
  const abs = path.normalize(fp)
  const match = matchSourceByDirectoryPrefix(config.sources || [], abs)
  if (!match) {
    log.debug({ entryId: entry.id, abs, branch: 'unmatched_unlink' }, 'removeFromFrame: physical')
    fs.unlinkSync(abs)
    return
  }

  const { source } = match
  const matchedSource = source.name ?? source.index

  if (source.type === 'nextcloud_tag') {
    log.debug({ entryId: entry.id, abs, branch: 'nextcloud_link', matchedSource }, 'removeFromFrame: physical')
    removeProjectionLink(abs, source, config)
    return
  }

  const policy = source.onRemoveFromFrame || config.mediaState?.localRemovalPolicy || 'trash'
  const trashPath = source.trashPath || config.mediaState?.localTrashPath

  if ((!source.type || source.type === 'local_folder') && policy === 'trash' && trashPath) {
    log.debug({ entryId: entry.id, abs, branch: 'trash_move', matchedSource, policy: 'trash' }, 'removeFromFrame: physical')
    moveToTrash(abs, path.resolve(trashPath))
    return
  }

  log.debug({ entryId: entry.id, abs, branch: 'unlink', matchedSource, policy }, 'removeFromFrame: physical')
  fs.unlinkSync(abs)
}

export const applyRemoveFromFramePhysical = (config, database, event) => {
  if (!hasRemoveFromFrame(event) || !database?.data?.length) {
    return []
  }

  const handled = []
  const idMap = new Map()
  for (const entry of database.data) {
    if (!idMap.has(entry.id)) {
      idMap.set(entry.id, [])
    }
    idMap.get(entry.id).push(entry)
  }

  for (const entryId of event.targetIds || []) {
    for (const entry of idMap.get(entryId) || []) {
      const paths = (entry.files || []).map(f => f?.filepath).filter(Boolean)
      if (!paths.length) {
        log.debug({ entryId: entry.id }, 'removeFromFrame: skip, no filepath')
        continue
      }
      for (const fp of paths) {
        try {
          removeFile(config, entry, fp)
        } catch (err) {
          log.warn(err, `removeFromFrame: failed for ${fp}, file left in place`)
        }
      }
      handled.push(entry)
    }
  }
  return handled
}
