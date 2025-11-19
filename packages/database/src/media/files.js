const toSlash = file => file.replaceAll(/\\/g, '/')

const mapFile = ({sha1sum, indexName, type, size, filename, filepath}) => ({ id: sha1sum, index: indexName, type, size, filename: toSlash(filename), filepath})

export const getFiles = entry => {
  return [mapFile(entry)].concat(entry.sidecars.map(mapFile))
}
