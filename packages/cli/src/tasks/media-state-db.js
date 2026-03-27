import fs from 'fs/promises'
import path from 'path'

import Database from 'better-sqlite3'
import Logger from '@home-gallery/logger'

const log = Logger('cli.task.mediaStateDb')

const initSchema = db => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      file_path TEXT NOT NULL,
      file_fingerprint TEXT NOT NULL,
      origin_tag TEXT,
      origin_mode TEXT CHECK(origin_mode IN ('file_tag', 'folder_tag', 'none')),
      origin_folder_path TEXT,
      state TEXT NOT NULL CHECK(state IN ('active', 'disabled', 'deleted_local')),
      disabled_at TEXT,
      deleted_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS media_source_fingerprint_uniq
      ON media(source_type, file_fingerprint);

    CREATE INDEX IF NOT EXISTS media_state_idx
      ON media(state);

    CREATE INDEX IF NOT EXISTS media_source_ref_idx
      ON media(source_ref);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      source_type TEXT NOT NULL CHECK(source_type IN ('nextcloud_tag')),
      tag_name TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK(target_type IN ('file', 'folder')),
      target_path TEXT NOT NULL,
      target_file_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active', 'deleted')),
      status_changed_at TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS tags_source_target_uniq
      ON tags(source_type, tag_name, target_type, target_path);

    CREATE INDEX IF NOT EXISTS tags_status_changed_at_idx
      ON tags(status_changed_at);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      entry_id TEXT,
      fingerprint TEXT,
      source_type TEXT,
      source_ref TEXT,
      file_path TEXT,
      from_state TEXT,
      to_state TEXT,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS events_entry_id_idx
      ON events(entry_id);

    CREATE INDEX IF NOT EXISTS events_created_at_idx
      ON events(created_at);
  `)
}

const getNow = () => new Date().toISOString()

export const initMediaStateDb = async dbPath => {
  if (!dbPath) {
    throw new Error(`mediaState.dbPath is required`)
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  try {
    initSchema(db)
  } finally {
    db.close()
  }

  log.debug(`Initialized media_state database schema at ${dbPath}`)
}

const withDb = (dbPath, fn) => {
  const db = new Database(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

export const upsertMediaStateTag = (dbPath, tag) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const statement = db.prepare(`
      INSERT INTO tags (
        source_type, tag_name, target_type, target_path, target_file_id, status, status_changed_at, observed_at
      ) VALUES (
        @source_type, @tag_name, @target_type, @target_path, @target_file_id, @status, @status_changed_at, @observed_at
      )
      ON CONFLICT(source_type, tag_name, target_type, target_path) DO UPDATE SET
        target_file_id=excluded.target_file_id,
        status=excluded.status,
        status_changed_at=excluded.status_changed_at,
        observed_at=excluded.observed_at
    `)

    statement.run({
      source_type: tag.source_type || 'nextcloud_tag',
      tag_name: tag.tag_name,
      target_type: tag.target_type,
      target_path: tag.target_path,
      target_file_id: tag.target_file_id || null,
      status: tag.status || 'active',
      status_changed_at: tag.status_changed_at || now,
      observed_at: tag.observed_at || now
    })
  })
}

export const upsertMediaStateEntry = (dbPath, entry) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const statement = db.prepare(`
      INSERT INTO media (
        entry_id, source_type, source_ref, file_path, file_fingerprint, origin_tag, origin_mode, origin_folder_path,
        state, disabled_at, deleted_at, last_seen_at, created_at, updated_at
      ) VALUES (
        @entry_id, @source_type, @source_ref, @file_path, @file_fingerprint, @origin_tag, @origin_mode, @origin_folder_path,
        @state, @disabled_at, @deleted_at, @last_seen_at, @created_at, @updated_at
      )
      ON CONFLICT(source_type, file_fingerprint) DO UPDATE SET
        entry_id=excluded.entry_id,
        source_ref=excluded.source_ref,
        file_path=excluded.file_path,
        origin_tag=excluded.origin_tag,
        origin_mode=excluded.origin_mode,
        origin_folder_path=excluded.origin_folder_path,
        state=CASE
          WHEN media.state IN ('disabled', 'deleted_local') THEN media.state
          ELSE excluded.state
        END,
        disabled_at=CASE
          WHEN media.state = 'disabled' THEN media.disabled_at
          ELSE excluded.disabled_at
        END,
        deleted_at=CASE
          WHEN media.state = 'deleted_local' THEN media.deleted_at
          ELSE excluded.deleted_at
        END,
        last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at
    `)

    statement.run({
      entry_id: entry.entry_id,
      source_type: entry.source_type,
      source_ref: entry.source_ref || null,
      file_path: entry.file_path,
      file_fingerprint: entry.file_fingerprint,
      origin_tag: entry.origin_tag || null,
      origin_mode: entry.origin_mode || 'none',
      origin_folder_path: entry.origin_folder_path || null,
      state: entry.state || 'active',
      disabled_at: entry.disabled_at || null,
      deleted_at: entry.deleted_at || null,
      last_seen_at: entry.last_seen_at || now,
      created_at: entry.created_at || now,
      updated_at: entry.updated_at || now
    })
  })
}

export const upsertMediaStateEntries = (dbPath, entries) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const statement = db.prepare(`
      INSERT INTO media (
        entry_id, source_type, source_ref, file_path, file_fingerprint, origin_tag, origin_mode, origin_folder_path,
        state, disabled_at, deleted_at, last_seen_at, created_at, updated_at
      ) VALUES (
        @entry_id, @source_type, @source_ref, @file_path, @file_fingerprint, @origin_tag, @origin_mode, @origin_folder_path,
        @state, @disabled_at, @deleted_at, @last_seen_at, @created_at, @updated_at
      )
      ON CONFLICT(source_type, file_fingerprint) DO UPDATE SET
        entry_id=excluded.entry_id,
        source_ref=excluded.source_ref,
        file_path=excluded.file_path,
        origin_tag=excluded.origin_tag,
        origin_mode=excluded.origin_mode,
        origin_folder_path=excluded.origin_folder_path,
        state=CASE
          WHEN media.state IN ('disabled', 'deleted_local') THEN media.state
          ELSE excluded.state
        END,
        disabled_at=CASE
          WHEN media.state = 'disabled' THEN media.disabled_at
          ELSE excluded.disabled_at
        END,
        deleted_at=CASE
          WHEN media.state = 'deleted_local' THEN media.deleted_at
          ELSE excluded.deleted_at
        END,
        last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at
    `)

    const tx = db.transaction(rows => {
      for (const entry of rows) {
        statement.run({
          entry_id: entry.entry_id,
          source_type: entry.source_type,
          source_ref: entry.source_ref || null,
          file_path: entry.file_path,
          file_fingerprint: entry.file_fingerprint,
          origin_tag: entry.origin_tag || null,
          origin_mode: entry.origin_mode || 'none',
          origin_folder_path: entry.origin_folder_path || null,
          state: entry.state || 'active',
          disabled_at: entry.disabled_at || null,
          deleted_at: entry.deleted_at || null,
          last_seen_at: entry.last_seen_at || now,
          created_at: entry.created_at || now,
          updated_at: entry.updated_at || now
        })
      }
    })
    tx(entries || [])
  })
}

export const appendMediaStateEvent = (dbPath, event) => {
  return withDb(dbPath, db => {
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
  })
}

export const listActiveTagsBySource = (dbPath, sourceTagName) => {
  return withDb(dbPath, db => {
    const statement = db.prepare(`
      SELECT *
      FROM tags
      WHERE source_type = 'nextcloud_tag'
        AND tag_name = @tag_name
        AND status = 'active'
      ORDER BY target_type, target_path
    `)
    return statement.all({ tag_name: sourceTagName })
  })
}

export const replaceMediaStateTagSnapshot = (dbPath, sourceTagName, records) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const updateDeleted = db.prepare(`
      UPDATE tags
      SET status = 'deleted',
          status_changed_at = @status_changed_at,
          observed_at = @observed_at
      WHERE source_type = 'nextcloud_tag'
        AND tag_name = @tag_name
        AND status = 'active'
    `)

    const upsert = db.prepare(`
      INSERT INTO tags (
        source_type, tag_name, target_type, target_path, target_file_id, status, status_changed_at, observed_at
      ) VALUES (
        'nextcloud_tag', @tag_name, @target_type, @target_path, @target_file_id, 'active', @status_changed_at, @observed_at
      )
      ON CONFLICT(source_type, tag_name, target_type, target_path) DO UPDATE SET
        target_file_id=excluded.target_file_id,
        status='active',
        status_changed_at=excluded.status_changed_at,
        observed_at=excluded.observed_at
    `)

    const tx = db.transaction((tagName, snapshotRows) => {
      updateDeleted.run({ tag_name: tagName, status_changed_at: now, observed_at: now })
      for (const row of snapshotRows) {
        upsert.run({
          tag_name: tagName,
          target_type: row.target_type,
          target_path: row.target_path,
          target_file_id: row.target_file_id || null,
          status_changed_at: row.status_changed_at || now,
          observed_at: row.observed_at || now
        })
      }
    })

    tx(sourceTagName, records || [])
  })
}

export const disableMissingNextcloudMediaEntries = (dbPath, sourceRef, originTag, seenFingerprints) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const rows = db.prepare(`
      SELECT id, entry_id, file_fingerprint, file_path
      FROM media
      WHERE source_type = 'nextcloud_tag'
        AND source_ref = @source_ref
        AND origin_tag = @origin_tag
        AND state = 'active'
    `).all({
      source_ref: sourceRef,
      origin_tag: originTag
    })

    const seen = new Set(seenFingerprints || [])
    const toDisable = rows.filter(row => !seen.has(row.file_fingerprint))
    if (!toDisable.length) {
      return []
    }

    const update = db.prepare(`
      UPDATE media
      SET state = 'disabled',
          disabled_at = @disabled_at,
          updated_at = @updated_at
      WHERE id = @id
    `)
    const tx = db.transaction(targetRows => {
      for (const row of targetRows) {
        update.run({
          id: row.id,
          disabled_at: now,
          updated_at: now
        })
      }
    })
    tx(toDisable)

    return toDisable
  })
}

export const listActiveNextcloudMediaEntries = (dbPath, sourceRef, originTag) => {
  return withDb(dbPath, db => {
    const statement = db.prepare(`
      SELECT entry_id, file_path, file_fingerprint, origin_mode, origin_folder_path, state
      FROM media
      WHERE source_type = 'nextcloud_tag'
        AND source_ref = @source_ref
        AND origin_tag = @origin_tag
        AND state = 'active'
      ORDER BY file_path
    `)
    return statement.all({
      source_ref: sourceRef,
      origin_tag: originTag
    })
  })
}

export const reenableEligibleNextcloudMediaEntries = (dbPath, sourceRef, originTag, candidates) => {
  const now = getNow()
  return withDb(dbPath, db => {
    const disabledRows = db.prepare(`
      SELECT id, file_fingerprint, disabled_at
      FROM media
      WHERE source_type = 'nextcloud_tag'
        AND source_ref = @source_ref
        AND origin_tag = @origin_tag
        AND state = 'disabled'
    `).all({
      source_ref: sourceRef,
      origin_tag: originTag
    })

    if (!disabledRows.length) {
      return []
    }

    const candidateByFingerprint = new Map()
    for (const candidate of candidates || []) {
      candidateByFingerprint.set(candidate.file_fingerprint, candidate)
    }

    const getFolderTagStatus = db.prepare(`
      SELECT status_changed_at
      FROM tags
      WHERE source_type = 'nextcloud_tag'
        AND tag_name = @tag_name
        AND target_type = 'folder'
        AND target_path = @target_path
        AND status = 'active'
      LIMIT 1
    `)

    const toEnable = []
    for (const row of disabledRows) {
      const candidate = candidateByFingerprint.get(row.file_fingerprint)
      if (!candidate) {
        continue
      }

      if (candidate.origin_mode === 'file_tag') {
        toEnable.push(row)
        continue
      }

      if (candidate.origin_mode !== 'folder_tag' || !candidate.origin_folder_path) {
        continue
      }

      const folderTag = getFolderTagStatus.get({
        tag_name: originTag,
        target_path: candidate.origin_folder_path
      })
      if (!folderTag?.status_changed_at || !row.disabled_at) {
        continue
      }
      if (folderTag.status_changed_at > row.disabled_at) {
        toEnable.push(row)
      }
    }

    if (!toEnable.length) {
      return []
    }

    const update = db.prepare(`
      UPDATE media
      SET state = 'active',
          disabled_at = NULL,
          updated_at = @updated_at
      WHERE id = @id
    `)
    const tx = db.transaction(rows => {
      for (const row of rows) {
        update.run({
          id: row.id,
          updated_at: now
        })
      }
    })
    tx(toEnable)
    return toEnable
  })
}
