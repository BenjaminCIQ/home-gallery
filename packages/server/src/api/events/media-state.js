import Database from 'better-sqlite3'
import Logger from '@home-gallery/logger'

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

export const applyMediaStateLifecycleEvent = async (config, event) => {
  const actions = getRelevantActions(event)
  if (!actions.length) {
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

    const selectByEntryId = db.prepare(`
      SELECT id, entry_id, file_fingerprint, source_type, source_ref, file_path, state
      FROM media
      WHERE entry_id = @entry_id
    `)
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

    const tx = db.transaction(() => {
      for (const entryId of event.targetIds || []) {
        const rows = selectByEntryId.all({ entry_id: entryId })
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
                currentState = 'disabled'
              }
              continue
            }

            if (action === ACTION_RESTORE) {
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
                currentState = 'active'
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
