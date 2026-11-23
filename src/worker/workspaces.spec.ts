import { expect, test } from 'bun:test'
import { INDEX_SECRET, LEGACY_SECRET, createWorkspaces, keySecret, type WorkspaceIndex } from './workspaces'

type Probe = (key: string) => Promise<{ workspaceId: string | null } | 'rejected'>

// Faux secrets en mémoire : `get` rend `undefined` pour un secret absent (l'hôte rend `null`, les deux sont tolérés).
function setup(probe: Probe = async () => ({ workspaceId: 'wrkspc_a' })) {
  const map = new Map<string, string>()
  const probed: string[] = []
  const logs: string[] = []
  let counter = 0
  const workspaces = createWorkspaces({
    secrets: {
      get: async (name: string) => map.get(name),
      set: async (name: string, value: string) => {
        map.set(name, value)
      },
      delete: async (name: string) => {
        map.delete(name)
      }
    } as never,
    probe: async (key) => {
      probed.push(key)
      return probe(key)
    },
    newId: () => `ws_${++counter}`,
    log: (message) => logs.push(message)
  })
  return { map, workspaces, probed, logs }
}

// Un probe qui rend le workspace propre à chaque clé de test.
const byKey =
  (table: Record<string, string | 'rejected'>): Probe =>
  async (key) => {
    const found = table[key]
    return found === 'rejected' ? 'rejected' : { workspaceId: found ?? null }
  }

const KEY_A = 'plugin-test-token-QUOKKA-a'
const KEY_B = 'plugin-test-token-QUOKKA-b'

test('migrate turns the legacy key into Default and deletes the legacy secret', async () => {
  const { map, workspaces } = setup(async () => ({ workspaceId: 'wrkspc_a' }))
  map.set(LEGACY_SECRET, KEY_A)
  await workspaces.migrate()
  const index = await workspaces.index()
  const id = index.entries[0]?.localId ?? ''
  expect(index.entries).toEqual([{ localId: id, name: 'Default', workspaceId: 'wrkspc_a' }])
  expect(index.activeLocalId).toBe(id)
  expect(index.migratedLocalId).toBe(id)
  expect(map.get(keySecret(id))).toBe(KEY_A)
  expect(map.get(LEGACY_SECRET)).toBe(undefined)
})

test('migrate keeps a null workspace id when the probe throws', async () => {
  const { map, workspaces } = setup(async () => {
    throw new Error('offline')
  })
  map.set(LEGACY_SECRET, KEY_A)
  await workspaces.migrate()
  const index = await workspaces.index()
  const id = index.entries[0]?.localId ?? ''
  expect(index.entries).toEqual([{ localId: id, name: 'Default', workspaceId: null }])
  expect(index.activeLocalId).toBe(id)
  expect(index.migratedLocalId).toBe(id)
  expect(map.get(keySecret(id))).toBe(KEY_A)
  expect(map.get(LEGACY_SECRET)).toBe(undefined)
})

test('migrate is a no-op once an index exists', async () => {
  const { map, workspaces, probed } = setup()
  map.set(INDEX_SECRET, JSON.stringify({ entries: [], activeLocalId: null, migratedLocalId: null }))
  map.set(LEGACY_SECRET, KEY_A)
  await workspaces.migrate()
  expect(probed).toEqual([])
  expect(map.get(LEGACY_SECRET)).toBe(KEY_A)
  expect((await workspaces.index()).entries).toEqual([])
})

test('migrate does nothing without a legacy key', async () => {
  const { map, workspaces } = setup()
  await workspaces.migrate()
  expect(map.size).toBe(0)
})

test('add keeps the active entry and refuses a rejected key', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'rejected' }))
  expect(await workspaces.add('First', KEY_A)).toEqual({ ok: true, value: undefined })
  const before = await workspaces.index()
  const secretsBefore = new Map(map)
  expect(await workspaces.add('Second', KEY_B)).toEqual({
    ok: false,
    code: 'unauthorized',
    error: 'The API key was rejected (401).'
  })
  expect(await workspaces.index()).toEqual(before)
  expect(map).toEqual(secretsBefore)
})

test('add maps a probe failure to an error and writes nothing', async () => {
  const { map, workspaces } = setup(async () => {
    throw new Error('boom')
  })
  const result = await workspaces.add('First', KEY_A)
  expect(result.ok).toBe(false)
  expect(map.size).toBe(0)
})

test('add refuses a key of a workspace already added', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_a' }))
  await workspaces.add('Default', KEY_A)
  const secretsBefore = new Map(map)
  expect(await workspaces.add('Again', KEY_B)).toEqual({
    ok: false,
    code: 'other',
    error: 'This key belongs to Default, already added.'
  })
  expect(map).toEqual(secretsBefore)
})

test('add refuses a key without workspace id', async () => {
  const { map, workspaces } = setup(async () => ({ workspaceId: null }))
  expect(await workspaces.add('Any', KEY_A)).toEqual({
    ok: false,
    code: 'other',
    error: 'Could not read the workspace of this key.'
  })
  expect(map.size).toBe(0)
})

test('add refuses an empty name or key before any probe', async () => {
  const { workspaces, probed } = setup()
  expect(await workspaces.add('   ', KEY_A)).toEqual({ ok: false, code: 'invalid', error: 'Name is required.' })
  expect(await workspaces.add('Name', '  ')).toEqual({ ok: false, code: 'invalid', error: 'API key is required.' })
  expect(probed).toEqual([])
})

test('add trims the name and the key', async () => {
  const { map, workspaces, probed } = setup()
  await workspaces.add('  Orca  ', `  ${KEY_A}  `)
  expect(probed).toEqual([KEY_A])
  const index = await workspaces.index()
  expect(index.entries[0]?.name).toBe('Orca')
  expect(map.get(keySecret('ws_1'))).toBe(KEY_A)
})

test('the first workspace added becomes active, the next ones do not', async () => {
  const { workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await workspaces.add('First', KEY_A)
  expect((await workspaces.index()).activeLocalId).toBe('ws_1')
  await workspaces.add('Second', KEY_B)
  const index = await workspaces.index()
  expect(index.activeLocalId).toBe('ws_1')
  expect(index.entries.map((entry) => entry.name)).toEqual(['First', 'Second'])
  expect(index.migratedLocalId).toBe(null)
})

test('the index never holds a key', async () => {
  const { map, workspaces } = setup()
  await workspaces.add('First', KEY_A)
  expect(map.get(INDEX_SECRET)?.includes(KEY_A)).toBe(false)
  expect(map.get(keySecret('ws_1'))).toBe(KEY_A)
})

test('rename trims, refuses an empty name and an unknown entry', async () => {
  const { workspaces } = setup()
  await workspaces.add('First', KEY_A)
  expect(await workspaces.rename('ws_1', '  Renamed ')).toEqual({ ok: true, value: undefined })
  expect(await workspaces.nameOf('ws_1')).toBe('Renamed')
  expect(await workspaces.rename('ws_1', ' ')).toEqual({ ok: false, code: 'invalid', error: 'Name is required.' })
  expect((await workspaces.rename('ws_9', 'x')).ok).toBe(false)
  expect(await workspaces.nameOf('ws_9')).toBe(null)
})

test('replaceKey swaps the key of the same workspace', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_a' }))
  await workspaces.add('First', KEY_A)
  expect(await workspaces.replaceKey('ws_1', KEY_B)).toEqual({ ok: true, value: undefined })
  expect(map.get(keySecret('ws_1'))).toBe(KEY_B)
})

test('replaceKey refuses a key of another workspace', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await workspaces.add('First', KEY_A)
  expect(await workspaces.replaceKey('ws_1', KEY_B)).toEqual({
    ok: false,
    code: 'other',
    error: 'This key is for wrkspc_b, not wrkspc_a.'
  })
  expect(map.get(keySecret('ws_1'))).toBe(KEY_A)
})

test('replaceKey refuses a rejected key and keeps the old one', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'rejected' }))
  await workspaces.add('First', KEY_A)
  const result = await workspaces.replaceKey('ws_1', KEY_B)
  expect(!result.ok && result.code).toBe('unauthorized')
  expect(map.get(keySecret('ws_1'))).toBe(KEY_A)
})

test('replaceKey learns the workspace id of an entry migrated without one', async () => {
  const { map, workspaces } = setup(async () => {
    throw new Error('offline')
  })
  map.set(LEGACY_SECRET, KEY_A)
  await workspaces.migrate()
  const id = (await workspaces.index()).entries[0]?.localId ?? ''
  const online = createWorkspaces({
    secrets: {
      get: async (name: string) => map.get(name),
      set: async (name: string, value: string) => {
        map.set(name, value)
      },
      delete: async (name: string) => {
        map.delete(name)
      }
    } as never,
    probe: async () => ({ workspaceId: 'wrkspc_a' }),
    newId: () => 'unused',
    log: () => {}
  })
  expect(await online.replaceKey(id, KEY_B)).toEqual({ ok: true, value: undefined })
  expect((await online.index()).entries[0]?.workspaceId).toBe('wrkspc_a')
  expect(map.get(keySecret(id))).toBe(KEY_B)
})

test('removing the active entry activates the first remaining one and deletes its key secret', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await workspaces.add('First', KEY_A)
  await workspaces.add('Second', KEY_B)
  expect(await workspaces.remove('ws_1')).toEqual({ ok: true, value: { activeChanged: true } })
  const index = await workspaces.index()
  expect(index.activeLocalId).toBe('ws_2')
  expect(index.entries.map((entry) => entry.localId)).toEqual(['ws_2'])
  expect(map.get(keySecret('ws_1'))).toBe(undefined)
  expect(map.get(keySecret('ws_2'))).toBe(KEY_B)
})

test('removing an inactive entry leaves the active one alone', async () => {
  const { map, workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await workspaces.add('First', KEY_A)
  await workspaces.add('Second', KEY_B)
  expect(await workspaces.remove('ws_2')).toEqual({ ok: true, value: { activeChanged: false } })
  expect((await workspaces.index()).activeLocalId).toBe('ws_1')
  expect(map.get(keySecret('ws_2'))).toBe(undefined)
})

test('removing the last entry clears the active one', async () => {
  const { map, workspaces } = setup()
  await workspaces.add('First', KEY_A)
  expect(await workspaces.remove('ws_1')).toEqual({ ok: true, value: { activeChanged: true } })
  const index: WorkspaceIndex = await workspaces.index()
  expect(index.activeLocalId).toBe(null)
  expect(index.entries).toEqual([])
  expect(map.get(keySecret('ws_1'))).toBe(undefined)
})

test('removing an unknown entry is refused', async () => {
  const { workspaces } = setup()
  const result = await workspaces.remove('ws_9')
  expect(!result.ok && result.code).toBe('other')
})

test('activate switches the active entry and says so', async () => {
  const { workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await workspaces.add('First', KEY_A)
  await workspaces.add('Second', KEY_B)
  expect(await workspaces.activate('ws_2')).toEqual({ ok: true, value: { activeChanged: true } })
  expect((await workspaces.index()).activeLocalId).toBe('ws_2')
  expect(await workspaces.activeKey()).toBe(KEY_B)
  expect(await workspaces.activate('ws_2')).toEqual({ ok: true, value: { activeChanged: false } })
})

test('activate an unknown localId is refused', async () => {
  const { workspaces } = setup()
  await workspaces.add('First', KEY_A)
  const result = await workspaces.activate('ws_9')
  expect(!result.ok && result.code).toBe('other')
  expect((await workspaces.index()).activeLocalId).toBe('ws_1')
})

test('unreadable index reads as empty, is logged and deletes no secret', async () => {
  const { map, workspaces, logs } = setup()
  map.set(INDEX_SECRET, '{')
  map.set(keySecret('ws_1'), KEY_A)
  expect(await workspaces.index()).toEqual({ entries: [], activeLocalId: null, migratedLocalId: null })
  expect(logs.length).toBe(1)
  expect(map.get(INDEX_SECRET)).toBe('{')
  expect(map.get(keySecret('ws_1'))).toBe(KEY_A)
  expect(await workspaces.activeKey()).toBe(null)
})

test('missing key of the active entry reads as no key and keeps the entry', async () => {
  const { map, workspaces } = setup()
  await workspaces.add('First', KEY_A)
  map.delete(keySecret('ws_1'))
  expect(await workspaces.activeKey()).toBe(null)
  expect((await workspaces.index()).entries.length).toBe(1)
})

test('noteWorkspaceId fills only an unknown id', async () => {
  const { map, workspaces } = setup(async () => {
    throw new Error('offline')
  })
  map.set(LEGACY_SECRET, KEY_A)
  await workspaces.migrate()
  const id = (await workspaces.index()).entries[0]?.localId ?? ''
  await workspaces.noteWorkspaceId(id, 'wrkspc_a')
  expect((await workspaces.index()).entries[0]?.workspaceId).toBe('wrkspc_a')
  await workspaces.noteWorkspaceId(id, 'wrkspc_other')
  expect((await workspaces.index()).entries[0]?.workspaceId).toBe('wrkspc_a')
})

test('concurrent writes do not lose an entry', async () => {
  const { workspaces } = setup(byKey({ [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b' }))
  await Promise.all([workspaces.add('First', KEY_A), workspaces.add('Second', KEY_B)])
  expect((await workspaces.index()).entries.length).toBe(2)
})
