/* globals gauge*/
"use strict"

const { Buffer } = require('buffer')
const https = require('https')
const assert = require('assert')
const fetch = require('node-fetch')
const express = require('express')

const { generateId, nextPort, runCliAsync, getBaseDir, getPath, getStorageDir, getDatabaseFilename, getEventsFilename } = require('../utils')

const servers = {}

const wait = async ms => new Promise(resolve => setTimeout(resolve, ms))

const onResponseNoop = res => res

const insecureOption = {
  agent: new https.Agent({
    rejectUnauthorized: false,
  })
}

const fetchFacade = path => {
  const url = gauge.dataStore.scenarioStore.get('serverUrl')
  assert(!!url, `Expected serverUrl but was empty. Start server first`)

  const headers = gauge.dataStore.scenarioStore.get('request.headers') || {}
  const agent = url.startsWith('https') ? insecureOption : {}
  return fetch(`${url}${path}`, Object.assign({timeout: 500, headers}, agent))
}

const waitForPath = async (path, timeout, onResponse) => {
  timeout = timeout || 10 * 1000
  const startTime = Date.now()

  const next = async () => {
    if (Date.now() - startTime > timeout) {
      throw new Error(`Wait timeout exceeded for path: ${path}`)
    }
    return fetchFacade(path)
      .then(onResponse || onResponseNoop)
      .catch(() => wait(200).then(next))
  }

  return next()
}

const waitForDatabase = async (timeout) => {
  return waitForPath('/api/database.json', timeout, res => {
    if (!res.ok) {
      throw new Error(`Database response is not successfull: Code is ${res.status}`)
    }
    return res.json().then(database => {
      if (!database.data.length) {
        return Promise.reject(new Error(`Database is empty`))
      }
      return database
    })
  })
}

const createServerId = () => {
  const serverId = generateId(4)
  const serverIds = gauge.dataStore.scenarioStore.get('serverIds') || []
  gauge.dataStore.scenarioStore.put('serverIds', [...serverIds, serverId])
  return serverId
}

const startServer = async (args = []) => {
  const serverId = createServerId()
  const port = await nextPort()
  const child = runCliAsync(['server', '-s', getStorageDir(), '-d', getDatabaseFilename(), '-e', getEventsFilename(), '--port', port, '--no-open-browser', ...args])

  const protocol = args.includes('-K') ? 'https' : 'http'
  const url = `${protocol}://localhost:${port}`
  servers[serverId] = {
    child,
    port,
    url
  }
  gauge.dataStore.scenarioStore.put('serverUrl', url)

  return waitForPath('', 10 * 1000)
}

step("Start server", startServer)

step("Start server with args <args>", async (args) => {
  const argList = args.split(/\s+/)
  await startServer(argList)
})

step("Start HTTPS server", async () => startServer(['-K', getPath('config', 'server.key'), '-C', getPath('config', 'server.crt')]))

step("Start static server", async () => {
  const serverId = createServerId()
  const port = await nextPort()

  const app = express()
  app.use(express.static(getBaseDir()))

  const url = `http://localhost:${port}`
  servers[serverId] = {
    server: false,
    port,
    url
  }
  gauge.dataStore.scenarioStore.put('serverUrl', url)

  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => {
      if (err) {
        return reject(err)
      }
      servers[serverId].server = server;
      resolve()
    })
  })
})

step("Start mock server", async () => {
  const serverId = createServerId()
  const port = await nextPort()

  const mockApiServer = (req, res, next) => {
    const paths = ['/faces', '/objects', '/embeddings']
    if (!paths.includes(req.path)) {
      return next()
    }
    return res.json({data:[]})
  }

  const mockGeoServer = (req, res, next) => {
    const paths = ['/reverse']
    if (!paths.includes(req.path)) {
      return next()
    }
    return res.json({
      osm_type: 'way',
      address: {
        road: 'Strada Provinciale SP286 Santa Caterina - Sant\'Isidoro - Porto Cesareo',
        town: 'Nardò',
        county: 'Lecce',
        state: 'Apulien',
        postcode: '73048',
        country: 'Italien',
        country_code: 'it'
      }
    })
  }

  const app = express()
  app.use(mockApiServer)
  app.use(mockGeoServer)

  const url = `http://localhost:${port}`
  servers[serverId] = {
    server: false,
    port,
    url
  }

  gauge.dataStore.scenarioStore.put('apiServerUrl', url)
  gauge.dataStore.scenarioStore.put('geoServerUrl', url)

  return new Promise((resolve, reject) => {
    const server = app.listen(port, (err) => {
      if (err) {
        return reject(err)
      }
      servers[serverId].server = server;
      resolve()
    })
  })
})

step("Wait for database", async () => await waitForDatabase(10 * 1000))

const killChildProcess = async child => {
  return new Promise(resolve => {
    const id = setTimeout(() => {
      child.kill('SIGKILL')
    }, 1000)

    child.on('exit', () => {
      clearTimeout(id)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

const stopServer = async serverId => {
  const server = servers[serverId]
  assert(!!server, `Server ${serverId} not found`)

  delete servers[serverId]
  if (server.child) {
    return killChildProcess(server.child)
  } else if (server.server) {
    server.server.close()
  }
}

step("Stop server", async () => {
  const serverIds = gauge.dataStore.scenarioStore.get('serverIds')
  await Promise.all(serverIds.map(id => stopServer(id)))
})

step("Request file <file>", async (file) => {
  return fetchFacade(file)
    .then(res => gauge.dataStore.scenarioStore.put('response.status', res.status))
})

step("Response status is <status>", async (status) => {
  const responseStatus = gauge.dataStore.scenarioStore.get('response.status')
  assert(responseStatus == status, `Expected response status ${status} but was ${responseStatus}`)
})

const btoa = text => Buffer.from(text).toString('base64')

step("Set user <user> with password <password>", async (user, password) => {
  const headers = gauge.dataStore.scenarioStore.get('request.headers') || {}
  headers['Authorization'] = `Basic ${btoa(user + ':' + password)}`
  gauge.dataStore.scenarioStore.put('request.headers', headers)
})

step("Server has file <file>", async (file) => {
  return fetchFacade(file)
    .then(res => {
      assert(res.ok, `Could not fetch file ${file}`)
    })
})

step("Database with query <query> has <amount> entries", async (query, amount) => {
  return fetchFacade(`/api/database${query}`)
    .then(res => {
      assert(res.ok, `Could not fetch file ${fetch}`)
      return res.json()
    })
    .then(data => {
      assert(data.data.length == amount, `Expected ${amount} entries but got ${data.data.length}`)
    })
})
