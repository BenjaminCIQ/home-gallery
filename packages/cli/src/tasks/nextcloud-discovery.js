import Logger from '@home-gallery/logger'

const log = Logger('cli.task.nextcloudDiscovery')

const normalizeBaseUrl = baseUrl => (baseUrl || '').replace(/\/+$/, '')

const toBase64 = value => Buffer.from(value, 'utf8').toString('base64')

const buildAuthHeader = ({ username, appPassword }) => `Basic ${toBase64(`${username}:${appPassword}`)}`

const extractHrefValues = xml => {
  const values = []
  const re = /<d:href>([^<]+)<\/d:href>/g
  let match = re.exec(xml)
  while (match) {
    values.push(match[1])
    match = re.exec(xml)
  }
  return values
}

const buildDavRootUrl = ({ baseUrl, username }) => {
  const encodedUser = encodeURIComponent(username)
  return `${normalizeBaseUrl(baseUrl)}/remote.php/dav/files/${encodedUser}/`
}

export const discoverNextcloudSourceCandidates = async (source, config) => {
  const baseUrl = config?.nextcloud?.baseUrl
  const username = config?.nextcloud?.username
  const appPassword = config?.nextcloud?.appPassword

  if (!baseUrl || !username || !appPassword) {
    throw new Error(`nextcloud.baseUrl, nextcloud.username and nextcloud.appPassword are required for native discovery`)
  }

  const url = buildDavRootUrl({ baseUrl, username })
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: buildAuthHeader({ username, appPassword }),
      Depth: '1',
      'Content-Type': 'application/xml'
    },
    body: `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:getetag />
    <d:getlastmodified />
    <d:resourcetype />
  </d:prop>
</d:propfind>`
  })

  if (!response.ok) {
    throw new Error(`Nextcloud PROPFIND failed for '${source.name || source.index}' with status ${response.status}`)
  }

  const xml = await response.text()
  const hrefs = extractHrefValues(xml)
  if (!hrefs.length) {
    log.warn(`No WebDAV href entries discovered for '${source.name || source.index}'`)
  } else {
    log.debug(`Discovered ${hrefs.length} WebDAV href entries for '${source.name || source.index}'`)
  }

  return {
    sourceName: source.name || source.index,
    hrefs
  }
}
