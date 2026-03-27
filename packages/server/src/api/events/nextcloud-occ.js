import { spawn } from 'child_process'

import Database from 'better-sqlite3'
import Logger from '@home-gallery/logger'

const log = Logger('server.api.events.nextcloudOcc')

const hasRemoveFromFrame = event => {
  const actions = event?.actions || []
  return actions.some(action => action?.action === 'removeFromFrame')
}

const runOccDeleteTag = (occCommand, fileId, tagName) => {
  const escapedTag = String(tagName).replace(/"/g, '\\"')
  const command = `${occCommand} tag:files:delete ${fileId} "${escapedTag}" public`
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`OCC tag delete command failed with exit code ${code}`))
      }
    })
  })
}

const getOccTargets = (dbPath, targetIds) => {
  const db = new Database(dbPath, { readonly: true })
  try {
    const statement = db.prepare(`
      SELECT entry_id, target_file_id, origin_tag
      FROM media
      WHERE entry_id = @entry_id
        AND source_type = 'nextcloud_tag'
        AND origin_mode = 'file_tag'
        AND target_file_id IS NOT NULL
    `)

    const targets = []
    for (const entryId of targetIds || []) {
      const row = statement.get({ entry_id: entryId })
      if (!row?.target_file_id || !row?.origin_tag) {
        continue
      }
      targets.push({
        entryId,
        fileId: row.target_file_id,
        tagName: row.origin_tag
      })
    }
    return targets
  } finally {
    db.close()
  }
}

export const applyNextcloudOccRemoveFromFrame = async (config, event) => {
  if (!hasRemoveFromFrame(event)) {
    return
  }

  const occCommand = config?.nextcloud?.occCommand
  if (!occCommand) {
    log.debug(`nextcloud.occCommand is not configured. Skip OCC removeFromFrame integration`)
    return
  }

  const dbPath = config?.mediaState?.dbPath
  if (!dbPath) {
    log.warn(`mediaState.dbPath missing. Skip OCC removeFromFrame integration`)
    return
  }

  const targets = getOccTargets(dbPath, event.targetIds)
  if (!targets.length) {
    return
  }

  const unique = new Map()
  for (const target of targets) {
    unique.set(`${target.fileId}:${target.tagName}`, target)
  }

  for (const target of unique.values()) {
    try {
      await runOccDeleteTag(occCommand, target.fileId, target.tagName)
      log.info(`Removed Nextcloud tag '${target.tagName}' from file ${target.fileId} for ${target.entryId}`)
    } catch (err) {
      log.warn(err, `Failed to remove Nextcloud tag '${target.tagName}' from file ${target.fileId} for ${target.entryId}`)
    }
  }
}
