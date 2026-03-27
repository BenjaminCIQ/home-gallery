import Logger from '@home-gallery/logger'

const log = Logger('cli.task.nextcloudDiscovery')

const normalizeBaseUrl = baseUrl => (baseUrl || '').replace(/\/+$/, '')

const toBase64 = value => Buffer.from(value, 'utf8').toString('base64')

const buildAuthHeader = ({ username, appPassword }) => `Basic ${toBase64(`${username}:${appPassword}`)}`

const buildDavRootUrl = ({ baseUrl, username }) => {
  const encodedUser = encodeURIComponent(username)
  return `${normalizeBaseUrl(baseUrl)}/remote.php/dav/files/${encodedUser}/`
}

const buildSystemTagsUrl = ({ baseUrl }) => `${normalizeBaseUrl(baseUrl)}/remote.php/dav/systemtags-assigned`

const extractTagId = (xml, tagName) => {
  const responseRe = /<d:response[\s\S]*?<\/d:response>/g
  let response = responseRe.exec(xml)
  while (response) {
    const chunk = response[0]
    const displayName = chunk.match(/<oc:display-name>([\s\S]*?)<\/oc:display-name>/)?.[1]?.trim()
    const id = chunk.match(/<oc:id>([\s\S]*?)<\/oc:id>/)?.[1]?.trim()
    if (displayName === tagName && id) {
      return id
    }
    response = responseRe.exec(xml)
  }
  return null
}

const parseTagTargetRows = ({ xml, username }) => {
  const rows = []
  const basePath = `/remote.php/dav/files/${encodeURIComponent(username)}/`
  const responseRe = /<d:response[\s\S]*?<\/d:response>/g
  let response = responseRe.exec(xml)
  while (response) {
    const chunk = response[0]
    const href = chunk.match(/<d:href>([\s\S]*?)<\/d:href>/)?.[1]?.trim()
    if (!href) {
      response = responseRe.exec(xml)
      continue
    }

    const decoded = decodeURIComponent(href)
    const relPath = decoded.includes(basePath) ? decoded.split(basePath)[1] : null
    if (!relPath || !relPath.length) {
      response = responseRe.exec(xml)
      continue
    }

    const resourceType = /<d:resourcetype>[\s\S]*?<d:collection\/>[\s\S]*?<\/d:resourcetype>/.test(chunk) ? 'folder' : 'file'
    const targetPath = relPath.replace(/\/+$/, '')
    const targetFileId = chunk.match(/<oc:fileid>([\s\S]*?)<\/oc:fileid>/)?.[1]?.trim() || null

    if (targetPath) {
      rows.push({
        target_type: resourceType,
        target_path: targetPath,
        target_file_id: targetFileId
      })
    }

    response = responseRe.exec(xml)
  }
  return rows
}

const fetchNextcloudTagId = async ({ baseUrl, username, appPassword, tagName }) => {
  const url = buildSystemTagsUrl({ baseUrl })
  const response = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      Authorization: buildAuthHeader({ username, appPassword }),
      Depth: '1',
      'Content-Type': 'application/xml'
    },
    body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <oc:id/>
    <oc:display-name/>
  </d:prop>
</d:propfind>`
  })
  if (!response.ok) {
    throw new Error(`Nextcloud system tag lookup failed with status ${response.status}`)
  }
  const xml = await response.text()
  return extractTagId(xml, tagName)
}

export const discoverNextcloudTagTargets = async (source, config) => {
  const baseUrl = config?.nextcloud?.baseUrl
  const username = config?.nextcloud?.username
  const appPassword = config?.nextcloud?.appPassword
  const tagName = source?.tag

  if (!baseUrl || !username || !appPassword) {
    throw new Error(`nextcloud.baseUrl, nextcloud.username and nextcloud.appPassword are required for native discovery`)
  }
  if (!tagName) {
    throw new Error(`nextcloud_tag source requires tag`)
  }

  const tagId = await fetchNextcloudTagId({ baseUrl, username, appPassword, tagName })
  if (!tagId) {
    log.warn(`Nextcloud tag '${tagName}' not found for source '${source.name || source.index}'`)
    return []
  }

  const userRoot = buildDavRootUrl({ baseUrl, username })
  const reportResponse = await fetch(userRoot, {
    method: 'REPORT',
    headers: {
      Authorization: buildAuthHeader({ username, appPassword }),
      Depth: 'infinity',
      'Content-Type': 'application/xml'
    },
    body: `<?xml version="1.0"?>
<oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns" xmlns:ocs="http://open-collaboration-services.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <oc:fileid/>
  </d:prop>
  <oc:filter-rules>
    <oc:systemtag>${tagId}</oc:systemtag>
  </oc:filter-rules>
</oc:filter-files>`
  })

  if (!reportResponse.ok) {
    throw new Error(`Nextcloud tagged target report failed for '${tagName}' with status ${reportResponse.status}`)
  }

  const xml = await reportResponse.text()
  const rows = parseTagTargetRows({ xml, username })
  const namedFolder = source?.namedFolder ? source.namedFolder.replace(/^\/+|\/+$/g, '') : null
  const filteredRows = namedFolder
    ? rows.filter(row => row.target_path === namedFolder || row.target_path.startsWith(`${namedFolder}/`))
    : rows

  log.debug(`Discovered ${filteredRows.length} tagged targets for '${source.name || source.index}'`)
  return filteredRows
}
