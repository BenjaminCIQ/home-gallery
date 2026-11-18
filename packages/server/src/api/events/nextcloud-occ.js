import { spawn } from 'child_process'

import Logger from '@home-gallery/logger'

import { selectMediaRowsForGalleryEntry } from '../database/gallery-media-state-resolve.js'
import { appendMediaStateEvent } from '../media-state-append-event.js'

const log = Logger('server.api.events.nextcloudOcc')

const hasRemoveFromFrame = event => {
  const actions = event?.actions || []
  return actions.some(action => action?.action === 'removeFromFrame')
}

const OCC_TIMEOUT_MS = 60000

const runOccDeleteTag = (occCommand, fileId, tagName) => {
  if (!/^\d+$/.test(String(fileId))) {
    return Promise.reject(new Error(`invalid file id '${fileId}'`))
  }
  // shortcut: occCommand split on whitespace, no quoted args; upgrade to array config if paths contain spaces
  const [bin, ...base] = String(occCommand).trim().split(/\s+/)
  const args = [...base, 'tag:files:delete', String(fileId), String(tagName), 'public']
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`OCC tag delete timed out after ${OCC_TIMEOUT_MS}ms: ${output.trim()}`))
    }, OCC_TIMEOUT_MS)
    const collect = chunk => { output += chunk }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', err => { clearTimeout(timer); reject(err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`OCC tag delete failed with exit code ${code}: ${output.trim()}`))
      } else if (/does not exist/i.test(output)) {
        // NC returns 0 when the tag is not found at this access level
        reject(new Error(`OCC tag delete reported: ${output.trim()}`))
      } else {
        resolve()
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
    log.debug({ reason: 'occCommand_missing' }, 'nextcloudOcc: skip removeFromFrame')
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
      log.debug({ eventId: event.id, entryId, reason: 'no_gallery_entry' }, 'nextcloudOcc: skip target')
      continue
    }
    const rows = selectMediaRowsForGalleryEntry(dbPath, config, galleryEntry)
    if (!rows.length) {
      log.debug({ eventId: event.id, entryId }, 'nextcloudOcc: no media rows for entry')
    }
    for (const row of rows) {
      if (row.source_type !== 'nextcloud_tag' || row.origin_mode !== 'file_tag') {
        log.debug(
          {
            eventId: event.id,
            entryId,
            reason: 'skip_not_file_tag',
            source_type: row.source_type,
            origin_mode: row.origin_mode,
            mediaRowId: row.id
          },
          'nextcloudOcc: row skipped'
        )
        continue
      }
      if (!row.target_file_id || !row.origin_tag) {
        log.debug(
          {
            eventId: event.id,
            entryId,
            reason: 'skip_missing_file_id_or_tag',
            target_file_id: row.target_file_id,
            origin_tag: row.origin_tag,
            mediaRowId: row.id
          },
          'nextcloudOcc: row skipped'
        )
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
      log.debug(
        { eventId: event.id, fileId: target.fileId, tagName: target.tagName, entryId: target.entryId },
        'nextcloudOcc: running OCC tag delete'
      )
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
