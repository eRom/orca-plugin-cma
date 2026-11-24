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

test('a path copied as path, with surrounding double quotes, loses them', () => {
  assert.deepEqual(pickedFromPath('"C:\\Users\\romain\\Mes documents\\a.md"'), { file: 'C:\\Users\\romain\\Mes documents\\a.md', name: 'a.md' })
  assert.deepEqual(pickedFromPath('  "/home/r/x y.md"  '), { file: '/home/r/x y.md', name: 'x y.md' })
  // Un seul guillemet, ou un nom qui en porte au milieu, n'est pas entouré : rien ne change.
  assert.equal(pickedFromPath('"C:\\a.md')?.file, '"C:\\a.md')
  assert.equal(pickedFromPath('/home/r/a"b.md')?.file, '/home/r/a"b.md')
  assert.equal(pickedFromPath('""'), null)
})

test('a file:// URL becomes a plain decoded path', () => {
  assert.deepEqual(pickedFromPath('file:///home/r/%C3%89t%C3%A9/a%20b.md'), { file: '/home/r/Été/a b.md', name: 'a b.md' })
  assert.deepEqual(pickedFromPath('file://localhost/home/r/a.md'), { file: '/home/r/a.md', name: 'a.md' })
  assert.deepEqual(pickedFromPath('FILE:///C:/Users/romain/a%20b.md'), { file: 'C:/Users/romain/a b.md', name: 'a b.md' })
  // Un « % » qui n'encode rien ne fait pas échouer le collage.
  assert.equal(pickedFromPath('file:///home/r/100%.md')?.file, '/home/r/100%.md')
  assert.equal(pickedFromPath('file://'), null)
})

test('a pasted root still gets a non-empty name, and an empty paste gives nothing', () => {
  assert.ok((pickedFromPath('C:\\')?.name ?? '') !== '')
  assert.ok((pickedFromPath('/')?.name ?? '') !== '')
  assert.equal(pickedFromPath('   '), null)
  assert.equal(pickedFromPath(''), null)
})
