import { PathLike } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { Event } from './models.js';
import { createHeader } from './header.js';

import Logger from '@home-gallery/logger'
const log = Logger('events.append')

// Serializes read-modify-write and append on the events file within this process
let lock: Promise<unknown> = Promise.resolve()
export const withEventsLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = lock.then(fn)
  lock = result.catch(() => {})
  return result
}

const stringifyNdJson = (value: any) => JSON.stringify(value) + '\n'

export const writeEvents = async (eventsFilename: PathLike, events: Event[]) => {
  const t0 = Date.now()
  const exists = await fs.access(eventsFilename).then(() => true).catch(() => false)
  if (!exists) {
    await fs.mkdir(path.dirname(eventsFilename.toString()), {recursive: true})
  }

  const data = stringifyNdJson(createHeader()) + events.map(stringifyNdJson).join('')
  await fs.writeFile(eventsFilename, data)
  log.debug(t0, `Wrote ${events.length} events to ${eventsFilename}`)
}

export const appendEvents = (eventsFilename: PathLike, events: Event[]) => withEventsLock(async () => {
  const t0 = Date.now()
  const stat = await fs.stat(eventsFilename).catch(err => err.code == 'ENOENT' ? false : Promise.reject(err))
  if (!stat || stat?.size === 0) {
    log.debug(`Events file ${eventsFilename} is missing or empty. Write new file`)
    return writeEvents(eventsFilename, events)
  }

  await fs.appendFile(eventsFilename, events.map(stringifyNdJson).join(''))
  log.debug(t0, `Append ${events.length} events to ${eventsFilename}`)
})

export const appendEvent = (eventsFilename: PathLike, event: Event) => appendEvents(eventsFilename, [event])
