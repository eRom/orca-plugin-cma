import { assert, test } from 'orca/testing'
import type { ThreadRow } from '../protocol'
import { pageWindow, rowBytes } from './thread-window'

function message(id: string, size = 1): ThreadRow {
  return { id, at: null, kind: 'agent_message', text: { text: 'x'.repeat(size), truncated: false } }
}

const five = ['r0', 'r1', 'r2', 'r3', 'r4'].map((id) => message(id))

test('pageWindow takes the last rows when pageEnd is null', () => {
  const { visible, firstIndex } = pageWindow(five, null, { maxRows: 3 })
  assert.equal(firstIndex, 2)
  assert.deepEqual(visible.map((r) => r.id), ['r2', 'r3', 'r4'])
})

test('pageWindow treats pageEnd as exclusive', () => {
  const { visible, firstIndex } = pageWindow(five, 2, { maxRows: 3 })
  assert.equal(firstIndex, 0)
  assert.deepEqual(visible.map((r) => r.id), ['r0', 'r1'])
})

test('pageWindow respects the byte budget', () => {
  const rows = Array.from({ length: 100 }, (_, i) => message(`m${i}`, 16_000))
  const { visible } = pageWindow(rows, null)
  const total = visible.reduce((sum, r) => sum + rowBytes(r), 0)
  assert.ok(total <= 384_000, `total ${total}`)
  assert.ok(visible.length >= 1)
  assert.ok(visible.length < 100)
})

test('pageWindow keeps a single oversized row alone', () => {
  const { visible, firstIndex } = pageWindow([message('small'), message('huge', 5_000)], null, { maxBytes: 1_000 })
  assert.deepEqual(visible.map((r) => r.id), ['huge'])
  assert.equal(firstIndex, 1)
})

test('pageWindow returns an empty window for no rows', () => {
  assert.deepEqual(pageWindow([], null), { visible: [], firstIndex: 0 })
})

test('rowBytes counts the UTF-8 size of the serialized row', () => {
  const row = message('a', 1)
  assert.equal(rowBytes(row), new TextEncoder().encode(JSON.stringify(row)).length)
})
