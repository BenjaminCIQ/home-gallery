import Logger from '@home-gallery/logger'

const log = Logger('cli.task.nextcloudDiscovery')

export const NEXTCLOUD_RECONCILE_SKIP_PREFIX = 'nextcloud_reconcile_skip:'

const skipError = reason => new Error(`${NEXTCLOUD_RECONCILE_SKIP_PREFIX}${reason}`)

const normalizeBaseUrl = baseUrl => (baseUrl || '').replace(/\/+$/, '')

const toBase64 = value => Buffer.from(value, 'utf8').toString('base64')

const buildAuthHeader = ({ username, appPassword }) => `Basic ${toBase64(`${username}:${appPassword}`)}`

const buildDavRootUrl = ({ baseUrl, username }) => {
  const encodedUser = encodeURIComponent(username)
  return `${normalizeBaseUrl(baseUrl)}/remote.php/dav/files/${encodedUser}/`
}

const buildSystemTagsUrl = ({ baseUrl }) => `${normalizeBaseUrl(baseUrl)}/remote.php/dav/systemtags-assigned`

const encodeDavPath = relPath => relPath.split('/').map(encodeURIComponent).join('/')

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
  const basePathEncoded = `/remote.php/dav/files/${encodeURIComponent(username)}/`
  const basePathRaw = `/remote.php/dav/files/${username}/`
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
    const relPath = decoded.includes(basePathEncoded)
      ? decoded.split(basePathEncoded)[1]
      : (decoded.includes(basePathRaw) ? decoded.split(basePathRaw)[1] : null)
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

const parseDavFileRows = ({ xml, username }) => {
  const rows = []
  const basePathEncoded = `/remote.php/dav/files/${encodeURIComponent(username)}/`
  const basePathRaw = `/remote.php/dav/files/${username}/`
  const responseRe = /<d:response[\s\S]*?<\/d:response>/g
  let response = responseRe.exec(xml)
  while (response) {
    const chunk = response[0]
    const href = chunk.match(/<d:href>([\s\S]*?)<\/d:href>/)?.[1]?.trim()
    if (!href) {
      response = responseRe.exec(xml)
      continue
    }

    const isFolder = /<d:resourcetype>[\s\S]*?<d:collection\/>[\s\S]*?<\/d:resourcetype>/.test(chunk)
    if (isFolder) {
      response = responseRe.exec(xml)
      continue
    }

    const decoded = decodeURIComponent(href)
    const relPath = decoded.includes(basePathEncoded)
      ? decoded.split(basePathEncoded)[1]
      : (decoded.includes(basePathRaw) ? decoded.split(basePathRaw)[1] : null)
    if (!relPath || !relPath.length) {
      response = responseRe.exec(xml)
      continue
    }

    const targetPath = relPath.replace(/\/+$/, '')
    const targetFileId = chunk.match(/<oc:fileid>([\s\S]*?)<\/oc:fileid>/)?.[1]?.trim() || null
    const etag = chunk.match(/<d:getetag>([\s\S]*?)<\/d:getetag>/)?.[1]?.trim() || null
    if (targetPath) {
      rows.push({
        target_path: targetPath,
        target_file_id: targetFileId,
        etag
      })
    }
    response = responseRe.exec(xml)
  }
  return rows
}

const fetchNextcloudTagId = async ({ baseUrl, username, appPassword, tagName }) => {
  const url = buildSystemTagsUrl({ baseUrl })
  let response
  try {
    response = await fetch(url, {
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
  } catch (err) {
    throw skipError(`network:systemtags:${err.message || err}`)
  }
  if (!response.ok) {
    throw skipError(`http:systemtags:${response.status}`)
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
    throw skipError(`tag_not_found:${tagName}`)
  }

  const userRoot = buildDavRootUrl({ baseUrl, username })
  let reportResponse
  try {
    reportResponse = await fetch(userRoot, {
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
  } catch (err) {
    throw skipError(`network:tag_report:${err.message || err}`)
  }

  if (!reportResponse.ok) {
    throw skipError(`http:tag_report:${reportResponse.status}`)
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

export const discoverNextcloudTaggedFiles = async (source, config, tagTargets = null) => {
  const baseUrl = config?.nextcloud?.baseUrl
  const username = config?.nextcloud?.username
  const appPassword = config?.nextcloud?.appPassword
  if (!baseUrl || !username || !appPassword) {
    throw new Error(`nextcloud.baseUrl, nextcloud.username and nextcloud.appPassword are required for native discovery`)
  }

  const targets = tagTargets || await discoverNextcloudTagTargets(source, config)
  const userRoot = buildDavRootUrl({ baseUrl, username })
  const authHeaders = {
    Authorization: buildAuthHeader({ username, appPassword }),
    'Content-Type': 'application/xml'
  }

  const fileTargets = targets.filter(row => row.target_type === 'file').map(row => ({
    ...row,
    origin_mode: 'file_tag',
    origin_folder_path: null
  }))
  const folderTargets = targets.filter(row => row.target_type === 'folder')

  const expandedFiles = []
  for (const folder of folderTargets) {
    const folderUrl = `${userRoot}${encodeDavPath(folder.target_path)}/`
    let response
    try {
      response = await fetch(folderUrl, {
        method: 'PROPFIND',
        headers: {
          ...authHeaders,
          Depth: 'infinity'
        },
        body: `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:resourcetype/>
    <d:getetag/>
    <oc:fileid/>
  </d:prop>
</d:propfind>`
      })
    } catch (err) {
      throw skipError(`network:folder_expand:${folder.target_path}:${err.message || err}`)
    }
    if (!response.ok) {
      throw skipError(`http:folder_expand:${folder.target_path}:${response.status}`)
    }
    const xml = await response.text()
    const rows = parseDavFileRows({ xml, username })
    for (const row of rows) {
      expandedFiles.push({
        ...row,
        target_type: 'file',
        origin_mode: 'folder_tag',
        origin_folder_path: folder.target_path
      })
    }
  }

  const uniqueByPath = new Map()
  for (const row of [...fileTargets, ...expandedFiles]) {
    uniqueByPath.set(row.target_path, row)
  }
  const files = [...uniqueByPath.values()]
  log.debug(`Expanded ${targets.length} tag targets into ${files.length} file candidates for '${source.name || source.index}'`)
  return files
}
