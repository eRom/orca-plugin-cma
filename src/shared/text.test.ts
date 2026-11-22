import { assert, test } from 'orca/testing'
import { clipBytes, clipBytesEnd } from './text'

test('clipBytes keeps short text untouched', () => {
  assert.deepEqual(clipBytes('hello', 10), { text: 'hello', truncated: false })
})

test('clipBytes cuts on a UTF-8 character boundary (2-byte chars)', () => {
  assert.deepEqual(clipBytes('é'.repeat(10), 5), { text: 'éé', truncated: true })
})

test('clipBytes never splits a 4-byte emoji', () => {
  assert.deepEqual(clipBytes('a😀b', 3), { text: 'a', truncated: true })
})

test('clipBytesEnd keeps the end of the text', () => {
  assert.deepEqual(clipBytesEnd('abcdef', 3), { text: 'def', truncated: true })
})

test('clipBytesEnd keeps short text untouched', () => {
  assert.deepEqual(clipBytesEnd('hello', 10), { text: 'hello', truncated: false })
})

test('clipBytesEnd never splits a 4-byte emoji', () => {
  assert.deepEqual(clipBytesEnd('😀b', 3), { text: 'b', truncated: true })
})
