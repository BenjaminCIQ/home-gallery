import fs from 'fs';
import http from 'http';
import https from 'https';
import open from 'open'

import { ProcessManager } from '@home-gallery/common'

import Logger from '@home-gallery/logger'
import { createPluginManager, QueryExecutor } from '@home-gallery/plugin'

const log = Logger('server')

import { EventBus } from './eventbus.js';
import { createApp } from './app.js'
import { spawnCli } from './utils/spawn-cli.js'
import { appendMediaStateEvent } from './api/media-state-append-event.js'

export { getPluginFiles } from './plugins.js'

const isHttps = (key, cert) => key && cert

function createServer(key, cert, app) {
  if (isHttps(key, cert)) {
    var privateKey  = fs.readFileSync(key, 'utf8');
    var certificate = fs.readFileSync(cert, 'utf8');

    var credentials = {key: privateKey, cert: certificate};

    return https.createServer(credentials, app);
  } else {
    return http.createServer({spdy: { plain: true, ssl: false} }, app);
  }
}

const serverUrl = (config) => {
  const { port, key, cert } = config.server
  return `${isHttps(key, cert) ? 'https' : 'http'}://localhost:${port}`
}

const getConfigEnv = options => {
  const { configFile, autoConfigFile } = options
  return !autoConfigFile && configFile ? {GALLERY_CONFIG: configFile} : {}
}

const MAX_RESPAWN_DELAY_MS = 5 * 60 * 1000

/** Spawn the import child and respawn it with growing delay when it exits unexpectedly */
const startImporter = (args, options, context, failures = 0) => {
  const { processManager, config } = context
  const startedAt = Date.now()
  const child = spawnCli(args, getConfigEnv(options))
  processManager.addProcess(child, 1 * 1000)
  child.once('exit', (code, signal) => {
    // a one-shot import (no --watch) ends with code 0 on purpose
    if (processManager.isStopped || (code === 0 && !args.includes('--watch'))) {
      return
    }
    // a child that ran for a while was healthy: restart the backoff
    const nextFailures = Date.now() - startedAt > MAX_RESPAWN_DELAY_MS ? 1 : failures + 1
    const delay = Math.min(5000 * 2 ** (nextFailures - 1), MAX_RESPAWN_DELAY_MS)
    log.warn(`Import process exited (code ${code}, signal ${signal}). Restart in ${delay / 1000}s`)
    appendMediaStateEvent(config?.mediaState?.dbPath, {
      event_type: 'import_failed',
      reason: `Import process exited with code ${code}, signal ${signal}. Restart in ${delay / 1000}s`
    })
    const timer = setTimeout(() => {
      if (!processManager.isStopped) {
        startImporter(args, options, context, nextFailures)
      }
    }, delay)
    timer.unref()
  })
}

const shutdown = (server, processManager) => {
  // use closeAllConnections from node >= v18.2.0
  if (typeof server?.closeAllConnections == 'function') {
    server.closeIdleConnections()
    server.closeAllConnections()
  }
  server.close(err => {
    if (err) {
      log.error(err, `Failed to stop server: ${err}`)
    }
  });
  return processManager.killAll('SIGINT')
}

/**
 * @param {import('@home-gallery/types').TPluginManager} manager
 * @returns {import('./types.js').TExecuteQueryFn}
 */
const createQueryExecutor = (manager) => {
  /** @type {import('@home-gallery/types').TQueryPlugin[]} */
  const queryPlugins = manager.getExtensions().filter(e => e.type == 'query').map(e => e.extension);
  const queryExecutor = new QueryExecutor()
  queryExecutor.addQueryPlugins(queryPlugins);
  return (entries, query, context) => queryExecutor.execute(entries, query, context)
}

export async function startServer(options) {
  const { config } = options

  const context = {
    type: 'serverContext',
    plugin: {},
    config,
    eventbus: new EventBus(),
    processManager: new ProcessManager(),
  }
  /** @type {import('@home-gallery/types').TGalleryPluginManager} */
  const pluginManager = await createPluginManager(options.config, context)
  context.pluginManager = pluginManager
  context.executeQuery = createQueryExecutor(pluginManager)

  const { app } = await createApp(context)

  return new Promise((resolve, reject) => {
    const { key, cert, port, host } = config.server
    const server = createServer(key, cert, app);
    server.listen(port, host)
      .on('error', err => {
        if (err.code === 'EADDRINUSE') {
          log.error(`Listening port ${port} is already in use!`);
        }
        reject(err)
      })
      .on('listening', () => resolve(server))
    }).then(async server => {
      const { importSources, watchSources, openBrowser } = config.server
      const url = serverUrl(config)
      log.info(`Your own Home Gallery is running at ${url}`);
      if (importSources) {
        const args = 'run import --initial --update'.split(' ');
        if (watchSources) {
          args.push('--watch')
        }
        startImporter(args, options, context)
      }
      if (openBrowser) {
        log.debug(`Open browser with url ${url}`)
        await open(url)
      }
      return [server, () => shutdown(server, context.processManager)]
    })

}
