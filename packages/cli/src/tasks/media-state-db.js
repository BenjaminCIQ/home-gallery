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
