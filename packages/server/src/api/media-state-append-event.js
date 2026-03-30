import Database from 'better-sqlite3'

import Logger from '@home-gallery/logger'

const log = Logger('server.api.mediaStateAppendEvent')

const getNow = () => new Date().toISOString()

/**
 * Append a row to media_state.events (same schema as CLI appendMediaStateEvent).
 * @param {string} dbPath
 * @param {object} event
 */
export const appendMediaStateEvent = (dbPath, event) => {
  if (!dbPath) {
    return
  }
  const db = new Database(dbPath)
  try {
    const statement = db.prepare(`
      INSERT INTO events (
        event_type, entry_id, fingerprint, source_type, source_ref, file_path, from_state, to_state, reason, created_at
      ) VALUES (
        @event_type, @entry_id, @fingerprint, @source_type, @source_ref, @file_path, @from_state, @to_state, @reason, @created_at
      )
    `)
    statement.run({
      event_type: event.event_type,
      entry_id: event.entry_id || null,
      fingerprint: event.fingerprint || null,
      source_type: event.source_type || null,
      source_ref: event.source_ref || null,
      file_path: event.file_path || null,
      from_state: event.from_state || null,
      to_state: event.to_state || null,
      reason: event.reason || null,
      created_at: event.created_at || getNow()
    })
  } catch (err) {
    log.warn(err, `Could not append media_state event ${event?.event_type}`)
  } finally {
    db.close()
  }
}
