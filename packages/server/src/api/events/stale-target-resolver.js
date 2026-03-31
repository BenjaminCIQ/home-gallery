const normalizePath = value => String(value || '').replace(/\\/g, '/')

const getHintByTargetId = event => {
  const byId = new Map()
  for (const hint of event?.targetHints || []) {
    if (hint?.id) {
      byId.set(hint.id, hint)
    }
  }
  return byId
}

export const resolveStaleRemoveTargets = (event, entries) => {
  const safeEntries = entries || []
  const id2Entry = new Map(safeEntries.map(entry => [entry.id, entry]))
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
    const candidates = safeEntries.filter(entry => {
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
