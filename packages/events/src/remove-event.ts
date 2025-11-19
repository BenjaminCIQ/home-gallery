import { PathLike } from 'fs';
import fs from 'fs/promises';
import path from 'path';

import { Event } from './models.js';
import { readEvents } from './read-events.js'
import { writeEvents } from './append-event.js'
import Logger from '@home-gallery/logger';

const log = Logger('events.remove');

export const removeEvent = async (eventsFilename: PathLike, eventToRemove: Event) => {

  const exists = await fs.access(eventsFilename).then(() => true).catch(() => false)
  if (!exists) {
    log.debug(`Event file ${eventsFilename} does not exists, create new event file`)
    return
  }

  const fileEvents = await readEvents(eventsFilename);

  // Find the event by ID
  const targetId = eventToRemove.id;
  const removedEvents = fileEvents.data.filter((ev: { id: string; }) => ev.id === targetId);

  if (!removedEvents.length) {
    log.debug(`Event with id ${targetId} not found. Nothing to remove.`);
    return null;
  }

  const remaining = fileEvents.data.filter((ev: { id: string; }) => ev.id !== targetId);

  // Rewrite file with only the remaining events
  await writeEvents(eventsFilename, remaining);

  log.info(`Removed event ${targetId} from ${eventsFilename}`);

  return removedEvents[0]; // return the actual removed event
};
