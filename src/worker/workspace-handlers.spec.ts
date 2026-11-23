import { expect, test } from 'bun:test'
import type { WorkspaceInfo } from '../protocol'
import { createWorkspaceHandlers } from './workspace-handlers'
import { createWorkspaces } from './workspaces'

const KEY_A = 'plugin-test-token-QUOKKA-a'
const KEY_B = 'plugin-test-token-QUOKKA-b'
const KEY_C = 'plugin-test-token-QUOKKA-c'

const INFO: WorkspaceInfo = { hasKey: true, keyRejected: false, workspaceId: 'wrkspc_a', organizationName: null, workspaces: [] }

function setup() {
  const map = new Map<string, string>()
  const calls: string[] = []
  let counter = 0
  const table: Record<string, string> = { [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b', [KEY_C]: 'wrkspc_a' }
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
    probe: async (key) => (table[key] ? { workspaceId: table[key] } : 'rejected'),
    newId: () => `ws_${++counter}`,
    log: () => {}
  })
  const handlers = createWorkspaceHandlers({
    workspaces,
    store: { reset: () => calls.push('store.reset') },
    watcher: { stop: () => calls.push('watcher.stop') },
    pendingWrites: { clear: () => calls.push('pending.clear') },
    poller: { start: () => calls.push('poller.start'), stop: () => calls.push('poller.stop') },
    info: async () => INFO,
    ready: Promise.resolve()
  })
  return { handlers, workspaces, calls, map }
}

const SWITCH = ['store.reset', 'watcher.stop', 'pending.clear', 'poller.start']

test('activate switches: client forgotten, watcher stopped, pending writes dropped, poller restarted', async () => {
  const { handlers, calls } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  expect(await handlers.activate({ localId: 'ws_2' })).toEqual({ ok: true, value: INFO })
  expect(calls).toEqual(SWITCH)
})

test('activate on the active workspace changes nothing', async () => {
  const { handlers, calls } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  calls.length = 0
  expect((await handlers.activate({ localId: 'ws_1' })).ok).toBe(true)
  expect(calls).toEqual([])
})

test('a refused activate switches nothing', async () => {
  const { handlers, calls } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  calls.length = 0
  const result = await handlers.activate({ localId: 'ws_9' })
  expect(!result.ok && result.code).toBe('other')
  expect(calls).toEqual([])
})

test('the first workspace added switches, the next ones and a refused add do not', async () => {
  const { handlers, calls } = setup()
  expect((await handlers.add({ name: 'First', key: KEY_A })).ok).toBe(true)
  expect(calls).toEqual(SWITCH)
  calls.length = 0
  expect((await handlers.add({ name: 'Second', key: KEY_B })).ok).toBe(true)
  expect((await handlers.add({ name: 'Bad', key: 'plugin-test-token-QUOKKA-bad' })).ok).toBe(false)
  expect(calls).toEqual([])
})

test('removing the active workspace switches, removing an inactive one does not', async () => {
  const { handlers, calls } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  await handlers.remove({ localId: 'ws_2' })
  expect(calls).toEqual([])
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  await handlers.remove({ localId: 'ws_1' })
  expect(calls).toEqual(SWITCH)
})

test('removing the last workspace stops the poller instead of restarting it', async () => {
  const { handlers, calls } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  calls.length = 0
  await handlers.remove({ localId: 'ws_1' })
  expect(calls).toEqual(['store.reset', 'watcher.stop', 'pending.clear', 'poller.stop'])
})

test('replacing the key of the active workspace forgets the client and restarts the poller only', async () => {
  const { handlers, calls, map } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  expect((await handlers.replaceKey({ localId: 'ws_1', key: KEY_C })).ok).toBe(true)
  expect(calls).toEqual(['store.reset', 'poller.start'])
  expect(map.get('anthropic-api-key:ws_1')).toBe(KEY_C)
  calls.length = 0
  expect((await handlers.replaceKey({ localId: 'ws_2', key: KEY_B })).ok).toBe(true)
  expect(calls).toEqual([])
})

test('rename switches nothing', async () => {
  const { handlers, calls, workspaces } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  calls.length = 0
  expect((await handlers.rename({ localId: 'ws_1', name: 'Renamed' })).ok).toBe(true)
  expect(await workspaces.nameOf('ws_1')).toBe('Renamed')
  expect(calls).toEqual([])
})

test('key.set adds Default when there is no workspace, then replaces the active key', async () => {
  const { handlers, workspaces, map } = setup()
  expect((await handlers.setKey({ key: KEY_A })).ok).toBe(true)
  expect((await workspaces.index()).entries.map((entry) => entry.name)).toEqual(['Default'])
  expect((await handlers.setKey({ key: KEY_C })).ok).toBe(true)
  expect(map.get('anthropic-api-key:ws_1')).toBe(KEY_C)
  const rejected = await handlers.setKey({ key: 'plugin-test-token-QUOKKA-bad' })
  expect(!rejected.ok && rejected.code).toBe('unauthorized')
  expect(map.get('anthropic-api-key:ws_1')).toBe(KEY_C)
})

test('key.clear removes the active workspace and hands back the info', async () => {
  const { handlers, workspaces, calls } = setup()
  await handlers.setKey({ key: KEY_A })
  calls.length = 0
  expect(await handlers.clearKey()).toEqual(INFO)
  expect((await workspaces.index()).entries).toEqual([])
  expect(calls).toEqual(['store.reset', 'watcher.stop', 'pending.clear', 'poller.stop'])
  expect(await handlers.clearKey()).toEqual(INFO)
})

test('a handler waits for the migration before reading the index', async () => {
  const map = new Map<string, string>()
  let finishMigration: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    finishMigration = resolve
  })
  const workspaces = createWorkspaces({
    secrets: { get: async (name: string) => map.get(name), set: async () => {}, delete: async () => {} } as never,
    probe: async () => ({ workspaceId: 'wrkspc_a' }),
    newId: () => 'ws_1',
    log: () => {}
  })
  let infoCalls = 0
  const handlers = createWorkspaceHandlers({
    workspaces,
    store: { reset: () => {} },
    watcher: { stop: () => {} },
    pendingWrites: { clear: () => {} },
    poller: { start: () => {}, stop: () => {} },
    info: async () => {
      infoCalls += 1
      return INFO
    },
    ready
  })
  const pending = handlers.info()
  await Promise.resolve()
  expect(infoCalls).toBe(0)
  finishMigration()
  expect(await pending).toEqual(INFO)
  expect(infoCalls).toBe(1)
})
