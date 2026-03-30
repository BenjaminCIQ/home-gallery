import { spawn } from 'child_process'

import Logger from '@home-gallery/logger'

import { selectMediaRowsForGalleryEntry } from '../database/gallery-media-state-resolve.js'
import { appendMediaStateEvent } from '../media-state-append-event.js'

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

export const applyNextcloudOccRemoveFromFrame = async (config, event, getGalleryEntry) => {
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

  const unique = new Map()
  for (const entryId of event.targetIds || []) {
    const galleryEntry = getGalleryEntry?.(entryId)
    if (!galleryEntry) {
      continue
    }
    const rows = selectMediaRowsForGalleryEntry(dbPath, config, galleryEntry)
    for (const row of rows) {
      if (row.source_type !== 'nextcloud_tag' || row.origin_mode !== 'file_tag') {
        continue
      }
      if (!row.target_file_id || !row.origin_tag) {
        continue
      }
      unique.set(`${row.target_file_id}:${row.origin_tag}`, {
        fileId: row.target_file_id,
        tagName: row.origin_tag,
        entryId: row.entry_id,
        source_type: row.source_type,
        source_ref: row.source_ref,
        file_path: row.file_path
      })
    }
  }

  for (const target of unique.values()) {
    try {
      await runOccDeleteTag(occCommand, target.fileId, target.tagName)
      log.info(`Removed Nextcloud tag '${target.tagName}' from file ${target.fileId} for ${target.entryId}`)
    } catch (err) {
      log.warn(err, `Failed to remove Nextcloud tag '${target.tagName}' from file ${target.fileId} for ${target.entryId}`)
      appendMediaStateEvent(dbPath, {
        event_type: 'nextcloud_occ_tag_delete_failed',
        entry_id: target.entryId,
        source_type: target.source_type || 'nextcloud_tag',
        source_ref: target.source_ref || null,
        file_path: target.file_path || null,
        reason: `tag:${target.tagName} fileId:${target.fileId} error:${err?.message || String(err)}`
      })
    }
  }
}
