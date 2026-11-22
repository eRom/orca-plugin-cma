import { assert, test } from 'orca/testing'
import type { ThreadRow } from '../protocol'
import { mergeRows, popView, prependRows, pushView, type NavEntry } from './state'

const home: NavEntry = { view: 'home' }

test('pushView caps the stack at 3', () => {
  let stack: NavEntry[] = [home]
  for (const sessionId of ['a', 'b', 'c', 'd']) {
    stack = pushView(stack, { view: 'session', sessionId })
  }
  assert.equal(stack.length, 3)
  assert.deepEqual(stack[2], { view: 'session', sessionId: 'd' })
})

test('popView never drops home', () => {
  assert.deepEqual(popView([home]), [home])
})

function line(id: string, text = id): ThreadRow {
  return { id, at: null, kind: 'agent_message', text: { text, truncated: false } }
}

test('mergeRows replaces known ids in place and appends the rest without cutting', () => {
  const merged = mergeRows([line('a'), line('b', 'old')], [line('b', 'new'), line('c')])
  assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c'])
  assert.equal((merged[1] as { text: { text: string } }).text.text, 'new')
  assert.equal(mergeRows([], Array.from({ length: 500 }, (_, i) => line(`r${i}`))).length, 500)
})

test('prependRows puts older rows first and skips the ones already known', () => {
  const { rows, added } = prependRows([line('c'), line('d')], [line('a'), line('b'), line('c')])
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b', 'c', 'd'])
  assert.equal(added, 2)
})
