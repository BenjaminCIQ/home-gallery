import fs from "fs"
import { PathLike } from 'fs';
import { Event, EventAction } from './models.js';

import { Taggable } from './taggable.js';

import { removeEvent } from './remove-event.js'

const removeEntryFile = <T extends Taggable>(data: T, event: Event, eventsFileName: PathLike): boolean => {
  if (!data.files || !data.files.length) {
    return false;
  }
  const filePath = data.files[0].filepath
  try {
    fs.unlinkSync(filePath);
    removeEvent(eventsFileName, event)
  } catch (err) {
    console.error("Error deleting file:", err);
  }
  return true;
}

type ApplyEventsServerOptions = {
  skipRemoveFromFrameFile?: boolean
}

const applyEventAction = <T extends Taggable>(data: T, action: EventAction, event: Event, eventsFileName: PathLike, options?: ApplyEventsServerOptions): boolean => {
  let changed = false;
  switch (action.action) {
    case 'addTag': {
      const tagValue = action.value ?? ''
      if (!tagValue) {
        break
      }
      if (!data.tags) {
        data.tags = [];
      }
      if (data.tags.indexOf(tagValue) < 0) {
        data.tags.push(tagValue);
        changed = true;
      }
      break;
    }
    case 'removeTag': {
      const removeValue = action.value ?? ''
      if (!removeValue) {
        return false;
      }
      if (!data.tags || !data.tags.length) {
        return false;
      }
      const index = data.tags.indexOf(removeValue);
      if (index >= 0) {
        data.tags.splice(index, 1);
        changed = true;
      }
      break;
    }
    case 'delete': {
      changed = removeEntryFile(data, event, eventsFileName) || changed;
      break;
    }
    case 'removeFromFrame': {
      if (options?.skipRemoveFromFrameFile) {
        changed = true;
      } else {
        changed = removeEntryFile(data, event, eventsFileName) || changed;
      }
      break;
    }
  }
  return changed;
}

const isValidEvent = (event: Event) => {
  return event.type == 'userAction' && event.targetIds?.length && event.actions?.length
}

const applyEventDate = (entry: Taggable, event: Event) => {
  if (!event.date) {
    return
  } else if (!entry.updated || entry.updated < event.date) {
    entry.updated = event.date
  }
}

type EntryIdMap = {[key: string]: Taggable[]}

const idMapReducer = (result: EntryIdMap, entry: Taggable) => {
  const id = entry.id
  if (!result[id]) {
    result[entry.id] = [entry]
  } else {
    result[id].push(entry)
  }

  return result
}

const flattenReducer = (result: Taggable[], entry: Taggable[]) => {
  result.push(...entry)
  return result
}

export const applyEvents = (entries: Taggable[], events: Event[], eventsFilename: PathLike, options?: ApplyEventsServerOptions): Taggable[] => {
  // on server side duplicated entries ids may exists
  const id2Entries: EntryIdMap = entries.reduce(idMapReducer, {} as EntryIdMap)

  const changedEntries: Taggable[] = [];
  events.filter(isValidEvent).forEach(event => {
    const eventId = event.id;
    const targetEntries: Taggable[] = event.targetIds
      .filter(entryId => id2Entries[entryId]?.length)
      .map(entryId => id2Entries[entryId])
      .reduce(flattenReducer, [] as Taggable[])
      .filter((entry: Taggable) => !entry.appliedEventIds || entry.appliedEventIds.indexOf(eventId) < 0);

    targetEntries.forEach(entry => {
      let changed = false;
      event.actions.forEach(action => {
        changed = applyEventAction(entry, action, event, eventsFilename, options) || changed;
      });

      if (!entry.appliedEventIds) {
        entry.appliedEventIds = [];
      }
      entry.appliedEventIds.push(event.id);
      if (changed) {
        if (!changedEntries.includes(entry)) {
          changedEntries.push(entry);
        }
        applyEventDate(entry, event);
      }
    })
  })
  return changedEntries;
}
