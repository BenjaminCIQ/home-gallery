
import { v4 as uuidv4 } from 'uuid';
import type { Event, EventAction } from '@home-gallery/events'
import { pushEvent as pushEventApi, eventStream as eventStreamApi} from './api';
import { UnsavedEventHandler } from './UnsavedEventHandler';
import { type Tag } from './models';
import { EventBus } from './EventBus';

export { fetchAll, fetchSyncNotifications, getEvents, mapEntriesForBrowser } from './api'

const tagToAction = (tag: Tag): EventAction => {
  if (tag.remove) {
    return {action: 'removeTag', value: tag.name}
  } else {
    return {action: 'addTag', value: tag.name}
  }
}

export const addTags = async (entryIds: string[], tags: Tag[]) => {
  const actions = tags.map(tagToAction);
  const event: Event = {type: 'userAction', id: uuidv4(), targetIds: entryIds, actions };
  return pushEvent(event);
}

export type RemoveFromFrameTargetHint = {
  filepath?: string;
  hash?: string;
}

export const removeFromFrame = async(entryID: string, hint?: RemoveFromFrameTargetHint) => {
  const event: Event = {
    type: 'userAction',
    id: uuidv4(),
    targetIds: [entryID],
    targetHints: hint ? [{ id: entryID, filepath: hint.filepath, hash: hint.hash }] : undefined,
    actions: [{action: 'removeFromFrame'}]
  };
  return pushEvent(event)
    .catch((err: any) => {
      if (err?.type === 'stale_target_id' || err?.status === 409) {
        console.warn('removeFromFrame stale target id detected; forcing page refresh')
        window.location.reload()
      }
      throw err
    });
}

let eventStreamSubscribed = false;

const unsavedEventHandler = new UnsavedEventHandler();
export const eventBus = new EventBus()

export const pushEvent = async (event: Event) => {
  unsavedEventHandler.addEvent(event)
  eventBus.dispatch(event)
  return pushEventApi(event)
    .catch(e => {
      console.log(`Event ${event.id} could not be sent: ${e}. Event will be lost on the next session`);
      throw e;
    });
}

export const eventStream = () => {
  if (!eventStreamSubscribed) {
    eventStreamSubscribed = true;
    eventStreamApi(unsavedEventHandler.middleware(event => eventBus.dispatch(event)));
  }
}
