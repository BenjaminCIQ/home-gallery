import Database from 'better-sqlite3'
import path from 'path'

import Logger from '@home-gallery/logger'

import { collectMediaRowsForGalleryEntryOnDb, matchSourceByDirectoryPrefix } from '../database/gallery-media-state-resolve.js'

const log = Logger('server.api.events.mediaState')

const ACTION_REMOVE = 'removeFromFrame'
const ACTION_RESTORE = 'restoreToFrame'

const getRelevantActions = event => (event?.actions || [])
  .map(action => action?.action)
  .filter(action => action === ACTION_REMOVE || action === ACTION_RESTORE)

const hasMediaTable = db => {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = 'media'
  `).get()
  return !!row
}

const normalizeRel = rel => rel.split(path.sep).join('/')

const ensureLocalMediaRow = (config, galleryEntry, now) => {
  const filepath = galleryEntry?.files?.[0]?.filepath
  if (!filepath) {
    return null
  }
  const abs = path.normalize(filepath)
  const locals = (config.sources || []).filter(s => !s.type || s.type === 'local_folder')
  const match = matchSourceByDirectoryPrefix(locals, abs)
  if (!match) {
    return null
  }
  const rel = normalizeRel(path.relative(match.root, abs))
  const sourceRef = match.source.name || match.source.index
  const fingerprint = `local:${sourceRef}:${rel}`
  return {
    entry_id: galleryEntry.id,
    source_type: 'local_folder',
    source_ref: sourceRef,
    file_path: rel,
    file_fingerprint: fingerprint,
    target_file_id: null,
    origin_tag: null,
    origin_mode: 'none',
    origin_folder_path: null,
    created_at: now,
    updated_at: now
  }
}

export const applyMediaStateLifecycleEvent = async (config, event, getGalleryEntry) => {
  const actions = getRelevantActions(event)
  if (!actions.length) {
    log.debug({ eventId: event?.id }, 'mediaState: no remove/restore actions')
    return
  }

  const dbPath = config?.mediaState?.dbPath
  if (!dbPath) {
    log.warn(`mediaState.dbPath missing. Skip media_state lifecycle transitions`)
    return
  }

  const now = event?.date || new Date().toISOString()
  const db = new Database(dbPath)
  try {
    if (!hasMediaTable(db)) {
      log.debug(`media_state.media table does not exist yet. Skip lifecycle transitions`)
      return
    }

    const setDisabled = db.prepare(`
      UPDATE media
      SET state = 'disabled',
          disabled_at = @disabled_at,
          updated_at = @updated_at
      WHERE id = @id
    `)
    const setActive = db.prepare(`
      UPDATE media
      SET state = 'active',
          disabled_at = NULL,
          updated_at = @updated_at
      WHERE id = @id
    `)
    const appendEvent = db.prepare(`
      INSERT INTO events (
        event_type, entry_id, fingerprint, source_type, source_ref, file_path, from_state, to_state, reason, created_at
      ) VALUES (
        @event_type, @entry_id, @fingerprint, @source_type, @source_ref, @file_path, @from_state, @to_state, @reason, @created_at
      )
    `)
    const insertMedia = db.prepare(`
      INSERT INTO media (
        entry_id, source_type, source_ref, file_path, file_fingerprint, target_file_id, origin_tag, origin_mode, origin_folder_path,
        state, disabled_at, deleted_at, last_seen_at, created_at, updated_at
      ) VALUES (
        @entry_id, @source_type, @source_ref, @file_path, @file_fingerprint, @target_file_id, @origin_tag, @origin_mode, @origin_folder_path,
        @state, @disabled_at, @deleted_at, @last_seen_at, @created_at, @updated_at
      )
      ON CONFLICT(source_type, file_fingerprint) DO UPDATE SET
        entry_id=excluded.entry_id,
        source_ref=excluded.source_ref,
        file_path=excluded.file_path,
        state=excluded.state,
        disabled_at=excluded.disabled_at,
        updated_at=excluded.updated_at
    `)

    const tx = db.transaction(() => {
      for (const entryId of event.targetIds || []) {
        const galleryEntry = getGalleryEntry?.(entryId)
        if (!galleryEntry) {
          log.debug({ eventId: event.id, entryId }, 'mediaState: skip, no gallery entry')
          continue
        }

        let rows = collectMediaRowsForGalleryEntryOnDb(db, config, galleryEntry)
        if (!rows.length && actions.includes(ACTION_REMOVE)) {
          const localRow = ensureLocalMediaRow(config, galleryEntry, now)
          if (localRow) {
            insertMedia.run({
              ...localRow,
              state: 'disabled',
              disabled_at: now,
              deleted_at: null,
              last_seen_at: now
            })
            log.debug(
              { eventId: event.id, entryId, fingerprint: localRow.file_fingerprint },
              'mediaState: inserted synthetic local media row'
            )
            rows = collectMediaRowsForGalleryEntryOnDb(db, config, galleryEntry)
          }
        }

        if (!rows.length) {
          log.debug({ eventId: event.id, entryId }, 'mediaState: no media rows for entry')
          continue
        }

        for (const row of rows) {
          let currentState = row.state
          for (const action of actions) {
            if (action === ACTION_REMOVE) {
              if (currentState === 'active') {
                setDisabled.run({ id: row.id, disabled_at: now, updated_at: now })
                appendEvent.run({
                  event_type: ACTION_REMOVE,
                  entry_id: row.entry_id,
                  fingerprint: row.file_fingerprint,
                  source_type: row.source_type,
                  source_ref: row.source_ref,
                  file_path: row.file_path,
                  from_state: currentState,
                  to_state: 'disabled',
                  reason: `userAction:${event.id}`,
                  created_at: now
                })
                log.debug(
                  {
                    eventId: event.id,
                    entryId,
                    mediaRowId: row.id,
                    fingerprint: row.file_fingerprint,
                    from_state: currentState,
                    to_state: 'disabled'
                  },
                  'mediaState: row disabled + lifecycle event'
                )
                currentState = 'disabled'
              } else {
                log.debug(
                  { eventId: event.id, entryId, mediaRowId: row.id, state: currentState },
                  'mediaState: skip remove, row not active'
                )
              }
              continue
            }

            if (action === ACTION_RESTORE) {
              if (row.origin_mode === 'folder_tag' && row.source_type === 'nextcloud_tag') {
                log.debug(
                  { eventId: event.id, entryId, mediaRowId: row.id },
                  'mediaState: skip restore folder_tag nextcloud row'
                )
                continue
              }
              if (currentState === 'disabled') {
                setActive.run({ id: row.id, updated_at: now })
                appendEvent.run({
                  event_type: ACTION_RESTORE,
                  entry_id: row.entry_id,
                  fingerprint: row.file_fingerprint,
                  source_type: row.source_type,
                  source_ref: row.source_ref,
                  file_path: row.file_path,
                  from_state: currentState,
                  to_state: 'active',
                  reason: `userAction:${event.id}`,
                  created_at: now
                })
                log.debug(
                  {
                    eventId: event.id,
                    entryId,
                    mediaRowId: row.id,
                    fingerprint: row.file_fingerprint,
                    from_state: currentState,
                    to_state: 'active'
                  },
                  'mediaState: row restored + lifecycle event'
                )
                currentState = 'active'
              } else {
                log.debug(
                  { eventId: event.id, entryId, mediaRowId: row.id, state: currentState },
                  'mediaState: skip restore, row not disabled'
                )
              }
            }
          }
        }
      }
    })
    tx()
  } finally {
    db.close()
  }
}
