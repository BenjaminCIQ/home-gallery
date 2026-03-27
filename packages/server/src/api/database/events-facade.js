import { applyEvents as applyEventsOrig } from '@home-gallery/events'
import { createHash, serialize } from '@home-gallery/common'

export const applyEvents = (database, events, eventsFilename, options) => {
  const changedEntries = applyEventsOrig(database.data, events, eventsFilename, options)
  changedEntries.forEach(entry => {
    entry.hash = createHash(serialize(entry, ['hash', 'appliedEventIds']))
  })
  return changedEntries
}
