import { assert, test } from 'orca/testing'
import { pickedFromPath } from './picker-fallback'

test('a pasted path is trimmed and named after its last segment, on either separator', () => {
  assert.deepEqual(pickedFromPath('  C:\\x\\y.md  '), { file: 'C:\\x\\y.md', name: 'y.md' })
  assert.deepEqual(pickedFromPath('/home/r/Été/x.md'), { file: '/home/r/Été/x.md', name: 'x.md' })
  assert.deepEqual(pickedFromPath('y.md'), { file: 'y.md', name: 'y.md' })
})

test('a pasted folder with a trailing separator is named after the folder', () => {
  assert.equal(pickedFromPath('/a/b/')?.name, 'b')
  assert.equal(pickedFromPath('C:\\a\\b\\')?.name, 'b')
})

test('a pasted root still gets a non-empty name, and an empty paste gives nothing', () => {
  assert.ok((pickedFromPath('C:\\')?.name ?? '') !== '')
  assert.ok((pickedFromPath('/')?.name ?? '') !== '')
  assert.equal(pickedFromPath('   '), null)
  assert.equal(pickedFromPath(''), null)
})
