import path from 'path'

import Database from 'better-sqlite3'

const normalizeRel = rel => rel.split(path.sep).join('/')

export const getNextcloudProjectionDir = (source, config) => {
  const root = config?.nextcloudProjection?.root
  if (!root) {
    return null
  }
  const sub = source?.projectionSubdir || source?.name || 'source'
  return path.resolve(root, sub)
}

export const matchSourceByDirectoryPrefix = (sources, absFile) => {
  const norm = path.normalize(absFile)
  let best = null
  let bestLen = -1
  for (const src of sources || []) {
    if (!src?.dir) {
      continue
    }
    const root = path.resolve(src.dir)
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
    if (norm === root || norm.startsWith(prefix)) {
      if (root.length > bestLen) {
        bestLen = root.length
        best = { source: src, root }
      }
    }
  }
  return best
}

export const collectMediaRowsForGalleryEntryOnDb = (db, config, galleryEntry) => {
  const filepath = galleryEntry?.files?.[0]?.filepath
  if (!filepath) {
    return []
  }
  const abs = path.normalize(filepath)
  const stmtNextcloud = db.prepare(`
    SELECT id, entry_id, file_fingerprint, source_type, source_ref, file_path, state, origin_mode, target_file_id, origin_tag
    FROM media
    WHERE source_type = 'nextcloud_tag'
      AND source_ref = @source_ref
      AND file_path = @file_path
  `)
  const stmtLocalByEntry = db.prepare(`
    SELECT id, entry_id, file_fingerprint, source_type, source_ref, file_path, state, origin_mode, target_file_id, origin_tag
    FROM media
    WHERE source_type = 'local_folder'
      AND entry_id = @entry_id
  `)

  const out = []
  for (const src of config.sources || []) {
    if (src.type === 'nextcloud_tag') {
      const projRoot = getNextcloudProjectionDir(src, config)
      if (!projRoot) {
        continue
      }
      const prefix = projRoot.endsWith(path.sep) ? projRoot : `${projRoot}${path.sep}`
      if (abs !== projRoot && !abs.startsWith(prefix)) {
        continue
      }
      const rel = normalizeRel(path.relative(projRoot, abs))
      const sourceRef = src.name || src.index
      out.push(...stmtNextcloud.all({ source_ref: sourceRef, file_path: rel }))
    }
  }

  const localMatch = matchSourceByDirectoryPrefix(
    (config.sources || []).filter(s => !s.type || s.type === 'local_folder'),
    abs
  )
  if (localMatch) {
    const rel = normalizeRel(path.relative(localMatch.root, abs))
    const sourceRef = localMatch.source.name || localMatch.source.index
    const fp = `local:${sourceRef}:${rel}`
    out.push(...db.prepare(`
      SELECT id, entry_id, file_fingerprint, source_type, source_ref, file_path, state, origin_mode, target_file_id, origin_tag
      FROM media
      WHERE source_type = 'local_folder'
        AND source_ref = @source_ref
        AND file_fingerprint = @file_fingerprint
    `).all({ source_ref: sourceRef, file_fingerprint: fp }))
  }

  out.push(...stmtLocalByEntry.all({ entry_id: galleryEntry.id }))

  const seen = new Set()
  return out.filter(row => {
    const key = `${row.source_type}:${row.id}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export const selectMediaRowsForGalleryEntry = (dbPath, config, galleryEntry) => {
  if (!dbPath) {
    return []
  }
  const db = new Database(dbPath, { readonly: true })
  try {
    return collectMediaRowsForGalleryEntryOnDb(db, config, galleryEntry)
  } finally {
    db.close()
  }
}
