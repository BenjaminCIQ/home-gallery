import { applyEvents as applyEventsOrig } from '@home-gallery/events'
import { createHash, serialize } from '@home-gallery/common'

export const applyEvents = (database, events, eventsFilename) => {
  const changedEntries = applyEventsOrig(database.data, events, eventsFilename)
  changedEntries.forEach(entry => {
    entry.hash = createHash(serialize(entry, ['hash', 'appliedEventIds']))
  })
  return changedEntries
}
