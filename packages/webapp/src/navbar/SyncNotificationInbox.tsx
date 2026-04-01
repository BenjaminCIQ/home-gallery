import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faBell } from '@fortawesome/free-solid-svg-icons'

import { fetchSyncNotifications, type SyncNotificationItem } from '../api/api'
import { useAppConfig } from '../config/useAppConfig'
import { classNames } from '../utils/class-names'

/** Max notification id the user has acknowledged; unread = items with id > this. */
const STORAGE_KEY = 'hg_sync_notifications_last_read_id'

const readLastReadId = (): number => {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v == null) {
      return 0
    }
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

const writeLastReadId = (id: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(id))
  } catch {
    /* ignore */
  }
}

const formatWhen = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    return ''
  }
  const diffMs = Date.now() - d.getTime()
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) {
    return 'just now'
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return `${min}m ago`
  }
  const hr = Math.floor(min / 60)
  if (hr < 48) {
    return `${hr}h ago`
  }
  return d.toLocaleString()
}

const severityRowClass = (severity: SyncNotificationItem['severity']) =>
  classNames('border rounded px-3 py-2 text-left w-full transition-colors', {
    'border-red-700/80 bg-red-950/35 text-gray-100': severity === 'error',
    'border-amber-600/70 bg-amber-950/25 text-gray-100': severity === 'warning',
    'border-gray-600 bg-gray-900/90 text-gray-200': severity === 'info'
  })

export const SyncNotificationInbox = () => {
  const appConfig = useAppConfig()
  const pollIntervalMs = useMemo(() => {
    const ms = (appConfig as { nextcloud?: { syncNotificationsPollIntervalMs?: number } }).nextcloud
      ?.syncNotificationsPollIntervalMs
    return typeof ms === 'number' && ms >= 1000 ? ms : 120_000
  }, [appConfig])

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [items, setItems] = useState<SyncNotificationItem[]>([])
  const [responseLimit, setResponseLimit] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [lastReadId, setLastReadId] = useState(readLastReadId)
  const wrapRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const data = await fetchSyncNotifications()
      setConfigured(data.configured)
      setItems(data.items || [])
      setResponseLimit(typeof data.limit === 'number' ? data.limit : null)
    } catch {
      setConfigured(false)
      setItems([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const t = window.setInterval(() => {
      load()
    }, pollIntervalMs)
    return () => window.clearInterval(t)
  }, [load, pollIntervalMs])

  useEffect(() => {
    if (!open) {
      return
    }
    const onDoc = (e: MouseEvent) => {
      const el = wrapRef.current
      if (el && !el.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (configured === false) {
    return null
  }

  const unreadCount = items.filter(i => i.id > lastReadId && (i.counts_as_unread !== false)).length
  const hasUnread = unreadCount > 0

  const markAllRead = () => {
    const maxId = items.reduce((m, i) => Math.max(m, i.id), 0)
    writeLastReadId(maxId)
    setLastReadId(maxId)
  }

  const toggleExpand = (id: number) => {
    setExpandedId(prev => (prev === id ? null : id))
  }

  return (
    <div className="relative flex items-center" ref={wrapRef}>
      <button
        type="button"
        className={classNames(
          'flex items-center justify-center p-2 rounded shadow cursor-pointer',
          hasUnread ? 'text-red-400 hover:bg-gray-700' : 'text-gray-400 hover:bg-gray-700 hover:text-gray-200'
        )}
        aria-label={hasUnread ? 'Sync notifications (unread)' : 'Sync notifications'}
        onClick={() => {
          setOpen(o => {
            const next = !o
            // Opening the panel marks everything as read so the badge clears; "Mark all read" does the same while open.
            if (!o && next && items.length) {
              markAllRead()
            }
            return next
          })
        }}
      >
        <FontAwesomeIcon icon={faBell} className="text-lg" />
        {hasUnread && (
          <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500" aria-hidden />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 w-[min(100vw-1rem,22rem)] max-h-[min(70vh,24rem)] overflow-y-auto rounded border border-gray-600 bg-gray-900 shadow-xl"
          role="dialog"
          aria-label="Nextcloud sync notifications"
        >
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-gray-700 bg-gray-900 px-3 py-2">
            <span className="text-sm font-medium text-gray-200">Sync notifications</span>
            {items.length > 0 && (
              <button
                type="button"
                className="text-xs text-gray-400 hover:text-gray-200"
                onClick={e => {
                  e.stopPropagation()
                  markAllRead()
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {items.length === 0 && (
            <p className="px-3 py-4 text-sm text-gray-500">No Nextcloud sync warnings or errors.</p>
          )}

          <ul className="flex flex-col gap-2 p-2">
            {items.map(item => (
              <li key={item.id}>
                <button
                  type="button"
                  className={severityRowClass(item.severity)}
                  onClick={() => toggleExpand(item.id)}
                >
                  <div className="flex justify-between gap-2 text-xs text-gray-500">
                    <span>{formatWhen(item.created_at)}</span>
                    {item.source_ref && <span className="truncate">{item.source_ref}</span>}
                  </div>
                  <div className="mt-1 text-sm font-medium">{item.title}</div>
                  <div className="mt-0.5 text-xs text-gray-400 line-clamp-2">{item.summary}</div>
                </button>
                {expandedId === item.id && item.detail && (
                  <pre className="mt-1 whitespace-pre-wrap break-words rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-300">
                    {item.detail}
                  </pre>
                )}
              </li>
            ))}
          </ul>

          {responseLimit != null && items.length > 0 && items.length === responseLimit && (
            <p className="border-t border-gray-700 px-3 py-2 text-xs text-gray-500">
              Showing {responseLimit} most recent warnings/errors.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
