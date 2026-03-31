
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

const notifyRefreshReason = (message: string) => {
  try {
    window.alert(message)
  } catch {
    // ignore UI alert failures
  }
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
    .then((result: any) => {
      if (result?.staleTargetRecovered) {
        console.warn('removeFromFrame recovered stale target id; forcing page refresh')
        notifyRefreshReason('Your gallery list changed during import. The item ID was corrected and the page will refresh now.')
        window.location.reload()
      }
      return result
    })
    .catch((err: any) => {
      if (err?.type === 'stale_target_id' || err?.status === 409) {
        console.warn('removeFromFrame stale target id detected; forcing page refresh')
        notifyRefreshReason('Your gallery list changed during import, so this action used an outdated item ID. The page will refresh; please retry.')
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
