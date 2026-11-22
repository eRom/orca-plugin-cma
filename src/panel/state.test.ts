import { assert, test } from 'orca/testing'
import { popView, pushView, type NavEntry } from './state'

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
