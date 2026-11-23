import { expect, test } from 'bun:test'
import type { WorkspaceInfo } from '../protocol'
import { createWorkspaceHandlers } from './workspace-handlers'
import { createWorkspaces } from './workspaces'

const KEY_A = 'plugin-test-token-QUOKKA-a'
const KEY_B = 'plugin-test-token-QUOKKA-b'
const KEY_C = 'plugin-test-token-QUOKKA-c'

const INFO: WorkspaceInfo = { hasKey: true, keyRejected: false, workspaceId: 'wrkspc_a', workspaces: [] }

function setup(info: () => Promise<WorkspaceInfo> = async () => INFO) {
  const logs: string[] = []
  const map = new Map<string, string>()
  const calls: string[] = []
  const announced: WorkspaceInfo[] = []
  // Quand vrai, `delete` lève (l'hôte refuse l'effacement d'un secret).
  const fail = { delete: false }
  let counter = 0
  const table: Record<string, string> = { [KEY_A]: 'wrkspc_a', [KEY_B]: 'wrkspc_b', [KEY_C]: 'wrkspc_a' }
  const workspaces = createWorkspaces({
    secrets: {
      get: async (name: string) => map.get(name),
      set: async (name: string, value: string) => {
        map.set(name, value)
      },
      delete: async (name: string) => {
        if (fail.delete) {
          throw new Error('host refused to delete')
        }
        map.delete(name)
      }
    } as never,
    probe: async (key) => (table[key] ? { workspaceId: table[key] } : 'rejected'),
    newId: () => `ws_${++counter}`,
    log: (message) => logs.push(message)
  })
  const handlers = createWorkspaceHandlers({
    workspaces,
    store: { reset: () => calls.push('store.reset') },
    watcher: { stop: () => calls.push('watcher.stop') },
    pendingWrites: { clear: () => calls.push('pending.clear') },
    poller: { start: () => calls.push('poller.start'), stop: () => calls.push('poller.stop') },
    info,
    announce: (value) => announced.push(value),
    log: (message) => logs.push(message),
    ready: Promise.resolve()
  })
  return { handlers, workspaces, calls, map, logs, announced, fail }
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
    announce: () => {},
    log: () => {},
    ready
  })
  const pending = handlers.info()
  await Promise.resolve()
  expect(infoCalls).toBe(0)
  finishMigration()
  expect(await pending).toEqual(INFO)
  expect(infoCalls).toBe(1)
})

test('activate still succeeds with a degraded info when reading the info fails', async () => {
  let failing = false
  const { handlers, calls, logs } = setup(async () => {
    if (failing) {
      throw new Error('Could not reach api.anthropic.com.')
    }
    return INFO
  })
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  failing = true
  const result = await handlers.activate({ localId: 'ws_2' })
  expect(calls).toEqual(SWITCH)
  expect(result).toEqual({
    ok: true,
    value: {
      hasKey: true,
      keyRejected: false,
      workspaceId: 'wrkspc_b',
      workspaces: [
        { localId: 'ws_1', name: 'First', workspaceId: 'wrkspc_a', active: false },
        { localId: 'ws_2', name: 'Second', workspaceId: 'wrkspc_b', active: true }
      ]
    }
  })
  expect(logs).toEqual(['workspace info unreadable, answered from the index: Could not reach api.anthropic.com.'])
})

test('add with an unreadable info succeeds, so a retry is not answered as a duplicate', async () => {
  const { handlers } = setup(async () => {
    throw new Error('offline')
  })
  const result = await handlers.add({ name: 'First', key: KEY_A })
  expect(result.ok).toBe(true)
  expect(result.ok && result.value.workspaces.map((row) => row.name)).toEqual(['First'])
})

test('a refused mutation still returns its own error when info would fail', async () => {
  const { handlers } = setup(async () => {
    throw new Error('offline')
  })
  const result = await handlers.activate({ localId: 'ws_9' })
  expect(!result.ok && result.code).toBe('other')
})

test('removing the active workspace still switches when the key secret cannot be deleted', async () => {
  const { handlers, calls, workspaces, fail, logs } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  calls.length = 0
  fail.delete = true
  const result = await handlers.remove({ localId: 'ws_1' })
  expect(result.ok).toBe(true)
  // Sans la bascule, le worker garderait le client, le sondeur et les écritures de A alors que l'index dit B.
  expect(calls).toEqual(SWITCH)
  expect((await workspaces.index()).activeLocalId).toBe('ws_2')
  expect(logs.join('\n').includes(KEY_A)).toBe(false)
})

test('workspace.info never throws: a network error answers from the index with the active row marked', async () => {
  const { handlers, logs } = setup(async () => {
    throw new Error('Could not reach api.anthropic.com.')
  })
  await handlers.add({ name: 'First', key: KEY_A })
  await handlers.add({ name: 'Second', key: KEY_B })
  await handlers.activate({ localId: 'ws_2' })
  logs.length = 0
  expect(await handlers.info()).toEqual({
    hasKey: true,
    keyRejected: false,
    workspaceId: 'wrkspc_b',
    workspaces: [
      { localId: 'ws_1', name: 'First', workspaceId: 'wrkspc_a', active: false },
      { localId: 'ws_2', name: 'Second', workspaceId: 'wrkspc_b', active: true }
    ]
  })
  expect(logs).toEqual(['workspace info unreadable, answered from the index: Could not reach api.anthropic.com.'])
})

test('a switch announces the fresh info to every panel, other changes announce nothing', async () => {
  const { handlers, announced } = setup()
  await handlers.add({ name: 'First', key: KEY_A })
  expect(announced).toEqual([INFO])
  announced.length = 0
  await handlers.add({ name: 'Second', key: KEY_B })
  await handlers.rename({ localId: 'ws_2', name: 'Renamed' })
  await handlers.replaceKey({ localId: 'ws_1', key: KEY_C })
  await handlers.activate({ localId: 'ws_1' })
  expect((await handlers.activate({ localId: 'ws_9' })).ok).toBe(false)
  expect(announced).toEqual([])
  await handlers.activate({ localId: 'ws_2' })
  expect(announced).toEqual([INFO])
  announced.length = 0
  await handlers.remove({ localId: 'ws_2' })
  expect(announced).toEqual([INFO])
})
