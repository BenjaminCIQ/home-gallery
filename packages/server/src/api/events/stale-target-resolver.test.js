import t from 'tap'

import { validateAndResolveRemoveTargets } from './stale-target-resolver.js'

t.test('resolves stale id by filepath hint', t => {
  const event = {
    targetIds: ['old-id'],
    targetHints: [{ id: 'old-id', filepath: '/gallery/a/b.jpg' }]
  }
  const entries = [
    { id: 'new-id', files: [{ filepath: '/gallery/a/b.jpg' }] }
  ]
  const result = validateAndResolveRemoveTargets(event, entries)
  t.same(result.resolvedTargetIds, ['new-id'])
  t.equal(result.unresolved.length, 0)
  t.same(result.recovered[0]?.oldId, 'old-id')
  t.same(result.recovered[0]?.newId, 'new-id')
  t.end()
})

t.test('resolves only unknown ids when targetIds override is used', t => {
  const event = {
    targetIds: ['known-id', 'old-id'],
    targetHints: [{ id: 'old-id', filepath: '/gallery/a/b.jpg' }]
  }
  const entries = [
    { id: 'known-id', files: [{ filepath: '/gallery/already-known.jpg' }] },
    { id: 'new-id', files: [{ filepath: '/gallery/a/b.jpg' }] }
  ]
  const result = validateAndResolveRemoveTargets(event, entries, ['old-id'])
  t.same(result.resolvedTargetIds, ['new-id'])
  t.equal(result.unresolved.length, 0)
  t.same(result.recovered[0]?.oldId, 'old-id')
  t.same(result.recovered[0]?.newId, 'new-id')
  t.end()
})

t.test('returns unresolved when hint is ambiguous', t => {
  const event = {
    targetIds: ['old-id'],
    targetHints: [{ id: 'old-id', filepath: '/gallery/shared.jpg' }]
  }
  const entries = [
    { id: 'id-1', files: [{ filepath: '/gallery/shared.jpg' }] },
    { id: 'id-2', files: [{ filepath: '/gallery/shared.jpg' }] }
  ]
  const result = validateAndResolveRemoveTargets(event, entries)
  t.same(result.resolvedTargetIds, [])
  t.equal(result.recovered.length, 0)
  t.same(result.unresolved[0]?.reason, 'ambiguous_hint')
  t.end()
})
