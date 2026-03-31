import { v4 as uuidv4 } from 'uuid';

import Logger from '@home-gallery/logger'

const log = Logger('server.api.events');

import { readEvents, appendEvent } from '@home-gallery/events';
import { applyNextcloudOccRemoveFromFrame } from './nextcloud-occ.js'
import { applyMediaStateLifecycleEvent } from './media-state.js'
import { appendMediaStateEvent } from '../media-state-append-event.js'

import { sendError } from '../error/index.js';

/**
 * @param {import('../../types.js').TServerContext} context
 * @param {string} eventsFilename
 * @returns
 */
export async function eventsApi(context) {
  const { config, eventbus, router } = context
  const mediaStateDbPath = config?.mediaState?.dbPath

  const hasRemoveFromFrame = event => (event?.actions || []).some(action => action?.action === 'removeFromFrame')
  const normalizePath = value => String(value || '').replace(/\\/g, '/')
  const getDatabaseEntries = () => context.database?.read?.()?.data || []
  const getHintByTargetId = event => {
    const byId = new Map()
    for (const hint of event?.targetHints || []) {
      if (hint?.id) {
        byId.set(hint.id, hint)
      }
    }
    return byId
  }

  const resolveStaleRemoveTargets = event => {
    const entries = getDatabaseEntries()
    const id2Entry = new Map(entries.map(entry => [entry.id, entry]))
    const hintByTargetId = getHintByTargetId(event)
    const resolvedTargetIds = []
    const unresolved = []
    const recovered = []

    for (const targetId of event?.targetIds || []) {
      if (id2Entry.has(targetId)) {
        resolvedTargetIds.push(targetId)
        continue
      }

      const hint = hintByTargetId.get(targetId)
      if (!hint) {
        unresolved.push({ targetId, reason: 'missing_hint' })
        continue
      }

      const filepath = normalizePath(hint.filepath)
      const hash = String(hint.hash || '')
      const candidates = entries.filter(entry => {
        if (hash && entry?.hash === hash) {
          return true
        }
        if (filepath) {
          return (entry?.files || []).some(file => normalizePath(file?.filepath) === filepath)
        }
        return false
      })

      if (candidates.length === 1) {
        const [candidate] = candidates
        resolvedTargetIds.push(candidate.id)
        recovered.push({
          oldId: targetId,
          newId: candidate.id,
          filepath: filepath || null,
          hash: hash || null
        })
      } else if (candidates.length > 1) {
        unresolved.push({ targetId, reason: 'ambiguous_hint', candidates: candidates.length })
      } else {
        unresolved.push({ targetId, reason: 'no_match_for_hint' })
      }
    }

    return { resolvedTargetIds, unresolved, recovered }
  }

  const getGalleryEntry = entryId => {
    const db = context.database?.read?.()
    if (!db?.data) {
      return undefined
    }
    return db.data.find(e => e.id === entryId)
  }
  const eventsFilename = config.events.file
  let clients = [];
  let events = false;

  const create = (type, data) => {
    return {
      type,
      id: uuidv4(),
      date: new Date().toISOString(),
      ...data
    }
  }

  const emit = (event) => {
    clients.forEach(c => {
      log.debug(`Send data to client ${c.id}`);
      c.res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
  }

  const brideServerEvents = eventNames => {
    eventNames.forEach(name => {
      eventbus.on(name, event => {
        emit(create(name, event))
      })
    })
  }

  const bridgeClientEvents = (event) => {
    eventbus.emit(event.type, event)
    process.nextTick(() => emit(event))
  }

  const removeClient = (client) => {
    const index = clients.indexOf(client);
    clients.splice(index, 1);
  }

  const isValidEvent = (data) => {
    if (!data.type) {
      return false;
    } else if (data.type === 'userAction' && (!data.targetIds || !data.targetIds.length || !data.actions || !data.actions.length)) {
      return false;
    }

    return true;
  }

  const stream = (req, res, next) => {
    const headers = {
      'Content-Type': 'text/event-stream',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache',
      "Content-Encoding": "none"
    };
    res.writeHead(200, headers);

    const clientId = uuidv4();
    const event = create('pong', {clientId})
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    const newClient = {
      id: clientId,
      res,
      toString: function() {
        return this.id;
      }
    };

    clients.push(newClient);
    log.info(`Add new client ${newClient}${req.username ? ' for user ' + req.username : ''}`);

    req.on('close', () => {
      log.debug(`Client connection closed. Remove client ${newClient}`);
      removeClient(newClient);
    });

    res.on('err', () => {
      log.warn(`Connection error. Remove client ${newClient}`);
      removeClient(newClient);
    });
  };

  const push = (req, res, next) => {
    const event = req.body;
    if (!isValidEvent(event)) {
      log.warn(`Received invalid event: ${JSON.stringify(event).substring(0, 120)}...`);
      return sendError(res, 400, `Invalid event data`)
    }
    if (!event.id) {
      event.id = uuidv4();
    }
    if (!event.date) {
      event.date = new Date().toISOString();
    }
    const actionNames = (event.actions || []).map(a => a.action).filter(Boolean)
    log.debug(
      { eventId: event.id, type: event.type, targetIds: event.targetIds, actions: actionNames },
      'push: received event'
    )
    if (event.type === 'userAction' && hasRemoveFromFrame(event)) {
      const { resolvedTargetIds, unresolved, recovered } = resolveStaleRemoveTargets(event)
      if (unresolved.length > 0) {
        log.warn(
          { eventId: event.id, targetIds: event.targetIds, unresolved },
          'push: stale target ids detected for removeFromFrame'
        )
        appendMediaStateEvent(mediaStateDbPath, {
          event_type: 'remove_from_frame_stale_target',
          reason: JSON.stringify({
            eventId: event.id,
            targetIds: event.targetIds || [],
            unresolved
          })
        })
        return res.status(409).json({
          error: {
            code: 409,
            type: 'stale_target_id',
            message: 'One or more selected items are stale. Refresh and retry.',
            staleTargetIds: unresolved.map(item => item.targetId)
          }
        })
      }
      if (recovered.length > 0) {
        log.warn(
          { eventId: event.id, recovered },
          'push: resolved stale target ids for removeFromFrame'
        )
        appendMediaStateEvent(mediaStateDbPath, {
          event_type: 'remove_from_frame_stale_target_resolved',
          reason: JSON.stringify({
            eventId: event.id,
            recovered
          })
        })
      }
      event.targetIds = resolvedTargetIds
      event.meta = {
        ...(event.meta || {}),
        staleTargetRecovered: recovered.length > 0,
        staleTargetRecoveredCount: recovered.length
      }
    }
    appendEvent(eventsFilename, event)
      .then(() => {
        log.debug({ eventId: event.id, stage: 'after_append' }, 'push: stage')
        return applyMediaStateLifecycleEvent(config, event, getGalleryEntry)
          .catch(err => {
            log.warn(err, `Failed to apply media_state lifecycle side effects for event ${event.id}`)
          })
          .then(() => event)
      })
      .then(() => {
        log.debug({ eventId: event.id, stage: 'after_media_state' }, 'push: stage')
        return applyNextcloudOccRemoveFromFrame(config, event, getGalleryEntry)
          .catch(err => {
            log.warn(err, `Failed to apply OCC removeFromFrame side effects for event ${event.id}`)
          })
          .then(() => event)
      })
      .then(() => {
        log.debug({ eventId: event.id, stage: 'after_occ' }, 'push: stage')
        log.info(`Saved event ${event.id} to ${eventsFilename}`);
        if (events !== false) {
          events.data.push(event);
        }
        log.debug({ eventId: event.id, stage: 'before_bridge' }, 'push: stage')
        bridgeClientEvents(event)
        res.status(201).json({
          ok: true,
          staleTargetRecovered: !!event?.meta?.staleTargetRecovered,
          staleTargetRecoveredCount: event?.meta?.staleTargetRecoveredCount || 0
        })
      })
      .catch(err => {
        log.error(err, `Could not save event to ${eventsFilename}. Error: ${err}. Event ${JSON.stringify(event).substring(0, 50)}...`);
        return sendError(res, 500, 'Failed to save event. See server logs for details.')
      })
  }

  const getEvents = cb => {
    if (events !== false) {
      return cb(null, events)
    }
    const t0 = Date.now();
    readEvents(eventsFilename)
      .then(data => {
        events = data;
        log.info(t0, `Read events file ${eventsFilename} with ${events.data.length} events`);
        cb(null, events)
      })
      .catch(err => {
        cb(err)
      })
  }

  const read = (_, res) => {
    const t0 = Date.now();
    getEvents((err, events) => {
      if (err && err.code === 'ENOENT') {
        log.info(`Events file ${eventsFilename} does not exist yet. It will be created on the first manual tag`);
        return sendError(res, 404, 'Events file does not exist yet. It will be created on the first manual tag')
      } else if (err) {
        log.error(err, `Failed to read events file ${eventsFilename}: ${err}`);
        return sendError(res, 500, 'Loading event file failed. See server logs')
      }
      log.debug(t0, `Send ${events.data.length} events`)
      return res.json(events);
    });
  }

  brideServerEvents(['server'])

  context.events = {
    read: getEvents
  }

  router.get('/api/events.json', read)
  router.post('/api/events', push)
  router.get('/api/events/stream', stream)
}
