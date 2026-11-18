import os from 'os'
import path from 'path'
import fs from 'fs'
import { setTimeout as sleep } from 'timers/promises'

import t from 'tap'

import {
  initMediaStateDb,
  upsertMediaStateEntry,
  replaceMediaStateTagSnapshot,
  reenableEligibleNextcloudMediaEntries,
  pruneMediaStateEvents,
  appendMediaStateEvent
} from './media-state-db.js'

const folder = { target_type: 'folder', target_path: '/Photos/2023' }
const candidate = { file_fingerprint: 'fp1', origin_mode: 'folder_tag', origin_folder_path: '/Photos/2023' }

t.test('folder_tag removal sticks until the folder tag is re-added', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-state-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'media-state.db')
  await initMediaStateDb(dbPath)

  replaceMediaStateTagSnapshot(dbPath, 'PhotoFrame', [folder])
  await sleep(5)
  upsertMediaStateEntry(dbPath, {
    entry_id: 'e1', source_type: 'nextcloud_tag', source_ref: 'src', file_path: '/p/a.jpg', file_fingerprint: 'fp1',
    origin_tag: 'PhotoFrame', origin_mode: 'folder_tag', origin_folder_path: '/Photos/2023',
    state: 'disabled', disabled_at: new Date().toISOString()
  })
  await sleep(5)

  const reenable = () => reenableEligibleNextcloudMediaEntries(dbPath, 'src', 'PhotoFrame', [candidate])

  for (let tick = 0; tick < 3; tick++) {
    replaceMediaStateTagSnapshot(dbPath, 'PhotoFrame', [folder])
    t.equal(reenable().length, 0, `still disabled after tick ${tick}`)
    await sleep(5)
  }

  replaceMediaStateTagSnapshot(dbPath, 'PhotoFrame', [])
  await sleep(5)
  replaceMediaStateTagSnapshot(dbPath, 'PhotoFrame', [folder])
  t.equal(reenable().length, 1, 're-added folder tag re-enables')
})

t.test('prune removes only old events by class', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-state-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'media-state.db')
  await initMediaStateDb(dbPath)

  const daysAgo = d => new Date(Date.now() - d * 24 * 3600 * 1000).toISOString()
  appendMediaStateEvent(dbPath, { event_type: 'nextcloud_discovery', created_at: daysAgo(40) })
  appendMediaStateEvent(dbPath, { event_type: 'nextcloud_discovery', created_at: daysAgo(1) })
  appendMediaStateEvent(dbPath, { event_type: 'media_disabled', created_at: daysAgo(40) })
  appendMediaStateEvent(dbPath, { event_type: 'media_disabled', created_at: daysAgo(200) })

  t.equal(pruneMediaStateEvents(dbPath), 2)
})
