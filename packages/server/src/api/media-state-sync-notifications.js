import { existsSync } from 'fs'

import Database from 'better-sqlite3'
import express from 'express'

import Logger from '@home-gallery/logger'

const log = Logger('server.api.mediaStateSyncNotifications')

const PREFIX = 'nextcloud_reconcile_skip:'

const SYNC_NOTIFICATIONS_ABSOLUTE_MAX = 200

// Every event type mapRow reports as warning or error; anything else is info and not shown.
const FAILURE_EVENT_TYPES = [
  'nextcloud_reconcile_skipped',
  'nextcloud_occ_tag_delete_failed',
  'nextcloud_projection_unsafe_path',
  'nextcloud_projection_missing_local_file',
  'nextcloud_projection_materialize_failed',
  'remove_from_frame_stale_target',
  'remove_from_frame_stale_target_resolved',
  'import_failed'
]

/** @param {object} [config] */
const resolveSyncNotificationsLimit = config => {
  const raw = config?.nextcloud?.syncNotificationsMaxItems
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 10
  return Math.min(Math.max(1, n), SYNC_NOTIFICATIONS_ABSOLUTE_MAX)
}

/**
 * @param {string} reason
 * @returns {{ title: string, summary: string, detail: string, severity: 'error'|'warning'|'info' }}
 */
const mapReconcileSkipped = reason => {
  const raw = reason || ''
  const rest = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw
  const detailLines = [raw]

  if (rest.startsWith('network:')) {
    const msg = rest.slice('network:'.length)
    detailLines.push('Check that the Home Gallery server can reach Nextcloud at nextcloud.baseUrl (correct URL, firewall, VPN).')
    return {
      severity: 'warning',
      title: 'Could not reach Nextcloud',
      summary: msg || 'Network error while talking to Nextcloud',
      detail: detailLines.join('\n\n')
    }
  }

  if (rest.startsWith('http:systemtags:') || rest.startsWith('http:tag_report:')) {
    const code = rest.split(':').pop() || ''
    detailLines.push('If your install uses a /nextcloud URL path, include it in nextcloud.baseUrl (e.g. https://host/nextcloud).')
    return {
      severity: 'warning',
      title: 'Nextcloud HTTP error during sync',
      summary: `Request failed (${code || rest})`,
      detail: detailLines.join('\n\n')
    }
  }

  if (rest.startsWith('local_dir_unavailable:')) {
    const dir = rest.slice('local_dir_unavailable:'.length)
    return {
      severity: 'warning',
      title: 'Photo drive not connected',
      summary: dir || 'Local photo folder not found',
      detail: `${raw}\n\nReconnect the drive. Sync is paused and the frame keeps its current photos.`
    }
  }

  if (rest.startsWith('tag_not_found:')) {
    const tag = rest.slice('tag_not_found:'.length)
    return {
      severity: 'warning',
      title: 'Nextcloud tag not found',
      summary: `No system tag named "${tag}"`,
      detail: raw
    }
  }

  return {
    severity: 'warning',
    title: 'Nextcloud sync skipped',
    summary: rest || 'See detail',
    detail: raw
  }
}

const mapRow = row => {
  const { id, event_type: eventType, source_ref: sourceRef, source_type: sourceType, file_path: filePath, reason, created_at: createdAt } = row

  const base = {
    id,
    event_type: eventType,
    source_ref: sourceRef,
    source_type: sourceType,
    file_path: filePath,
    created_at: createdAt,
    raw: { reason }
  }

  switch (eventType) {
    case 'nextcloud_reconcile_skipped': {
      const m = mapReconcileSkipped(reason)
      return { ...base, ...m }
    }
    case 'nextcloud_occ_tag_delete_failed':
      return {
        ...base,
        severity: 'error',
        title: 'Could not remove Nextcloud tag',
        summary: sourceRef ? `${sourceRef}: ${filePath || 'file'}` : (filePath || 'OCC tag delete failed'),
        detail: reason || 'OCC command failed'
      }
    case 'import_failed':
      return {
        ...base,
        severity: 'error',
        title: 'Photo import stopped — restarting',
        summary: sourceRef || 'Import process',
        detail: reason || ''
      }
    case 'nextcloud_projection_unsafe_path':
      return {
        ...base,
        severity: 'warning',
        title: 'Unsafe projection path skipped',
        summary: filePath || sourceRef || 'Path outside allowed roots',
        detail: reason || ''
      }
    case 'nextcloud_projection_missing_local_file':
      return {
        ...base,
        severity: 'warning',
        title: 'Missing local file for projection',
        summary: filePath || sourceRef || 'File not on disk',
        detail: reason || ''
      }
    case 'nextcloud_projection_materialize_failed':
      return {
        ...base,
        severity: 'error',
        title: 'Could not copy or link to projection folder',
        summary: filePath || sourceRef || 'Materialize failed',
        detail: reason || ''
      }
    case 'nextcloud_discovery':
      return {
        ...base,
        severity: 'info',
        title: 'Nextcloud discovery finished',
        summary: sourceRef || 'Discovery',
        detail: reason || ''
      }
    case 'nextcloud_projection_materialize':
      return {
        ...base,
        severity: 'info',
        title: 'Projection updated',
        summary: sourceRef || 'Materialize',
        detail: reason || ''
      }
    case 'remove_from_frame_stale_target':
      return {
        ...base,
        severity: 'warning',
        title: 'Remove from frame needs refresh',
        summary: 'Selection used outdated item IDs',
        detail: reason || ''
      }
    case 'remove_from_frame_stale_target_resolved':
      return {
        ...base,
        severity: 'warning',
        title: 'Remove from frame auto-corrected',
        summary: 'Outdated IDs were resolved to current entries',
        detail: reason || ''
      }
    default:
      return {
        ...base,
        severity: 'info',
        title: eventType || 'Nextcloud',
        summary: sourceRef || reason || '',
        detail: reason || ''
      }
  }
}

export async function mediaStateSyncNotificationsApi(context) {
  const { config, router } = context
  const r = express.Router()

  r.get('/sync-notifications.json', (req, res) => {
    const dbPath = config?.mediaState?.dbPath
    if (!dbPath || !existsSync(dbPath)) {
      return res.json({ configured: false, items: [] })
    }

    let db
    try {
      db = new Database(dbPath, { readonly: true })
    } catch (err) {
      log.warn(err, `Could not open media state db at ${dbPath}`)
      return res.json({ configured: true, items: [] })
    }

    try {
      const limit = resolveSyncNotificationsLimit(config)
      // Bare columns come from the MAX(id) row (SQLite min/max aggregate rule).
      const rows = db.prepare(`
        SELECT MAX(id) AS id, event_type, source_ref, source_type, file_path, reason, created_at, COUNT(*) AS repeat_count
        FROM events
        WHERE event_type IN (${FAILURE_EVENT_TYPES.map(() => '?').join(', ')})
        GROUP BY event_type, reason
      `).all(...FAILURE_EVENT_TYPES)

      // Collapse repeats of the same notification kind into its newest occurrence.
      const newestByKind = new Map()
      for (const row of rows) {
        const item = mapRow(row)
        const key = `${item.event_type}|${item.title}`
        const prev = newestByKind.get(key)
        const repeatCount = row.repeat_count + (prev?.repeat_count || 0)
        newestByKind.set(key, !prev || item.id > prev.id
          ? { ...item, repeat_count: repeatCount }
          : { ...prev, repeat_count: repeatCount })
      }

      const notifyOnlyFailures = true
      const items = [...newestByKind.values()]
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(item => ({ ...item, counts_as_unread: true }))
      return res.json({ configured: true, notifyOnlyFailures, limit, items })
    } catch (err) {
      log.error(err, 'Failed to read sync notifications')
      return res.status(500).json({ error: 'Failed to read notifications' })
    } finally {
      db.close()
    }
  })

  router.use('/api/media-state', r)
}
