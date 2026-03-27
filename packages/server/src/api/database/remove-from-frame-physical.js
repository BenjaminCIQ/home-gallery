import fs from 'fs'
import path from 'path'

import Logger from '@home-gallery/logger'

import { matchSourceByDirectoryPrefix } from './gallery-media-state-resolve.js'

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
    const entries = idMap.get(entryId) || []
    for (const entry of entries) {
      const fp = entry.files?.[0]?.filepath
      if (!fp) {
        continue
      }
      const abs = path.normalize(fp)
      const match = matchSourceByDirectoryPrefix(config.sources || [], abs)
      if (!match) {
        try {
          fs.unlinkSync(abs)
        } catch (err) {
          log.warn(err, `removeFromFrame: could not unlink ${abs}`)
        }
        handled.push(entry)
        continue
      }

      const { source } = match
      const policy = source.onRemoveFromFrame || config.mediaState?.localRemovalPolicy || 'trash'
      const trashPath = source.trashPath || config.mediaState?.localTrashPath

      if ((!source.type || source.type === 'local_folder') && policy === 'trash' && trashPath) {
        const destDir = path.resolve(trashPath)
        try {
          fs.mkdirSync(destDir, { recursive: true })
          const dest = uniqueDestPath(destDir, path.basename(abs))
          fs.renameSync(abs, dest)
        } catch (err) {
          log.warn(err, `removeFromFrame: trash move failed for ${abs}, falling back to unlink`)
          try {
            fs.unlinkSync(abs)
          } catch (err2) {
            log.warn(err2, `removeFromFrame: unlink failed for ${abs}`)
          }
        }
        handled.push(entry)
        continue
      }

      try {
        fs.unlinkSync(abs)
      } catch (err) {
        log.warn(err, `removeFromFrame: unlink failed for ${abs}`)
      }
      handled.push(entry)
    }
  }
  return handled
}
