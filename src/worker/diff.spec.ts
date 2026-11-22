import { expect, test } from 'bun:test'
import { diffDocuments, summarizeLines } from './diff'

const byteLength = (text: string | null): number => (text === null ? 0 : Buffer.byteLength(text))

test('diffDocuments lists changed and added scalars in the order of the new document', () => {
  expect(diffDocuments({ a: 1, b: { c: 'x' } }, { a: 2, b: { c: 'x' }, d: true })).toEqual([
    { path: 'a', before: '1', after: '2', lines: null },
    { path: 'd', before: null, after: 'true', lines: null }
  ])
})

test('diffDocuments returns nothing for equal documents', () => {
  const document = { name: 'x', tools: [{ type: 'bash', config: { enabled: true } }], nothing: null }
  expect(diffDocuments(document, structuredClone(document))).toEqual([])
})

test('diffDocuments counts the lines added to a long text and shortens both sides to 200 bytes', () => {
  const before = ['first line of the prompt', 'second line of the prompt', 'third line of the prompt'].join('\n').padEnd(400, '.')
  const after = `${before}\nfourth line`
  const [change, ...rest] = diffDocuments({ system: before }, { system: after })
  expect(rest).toEqual([])
  expect(change?.path).toBe('system')
  expect(change?.lines).toEqual({ added: 1, removed: 0 })
  expect(byteLength(change?.before ?? null)).toBeLessThanOrEqual(200)
  expect(byteLength(change?.after ?? null)).toBeLessThanOrEqual(200)
})

test('diffDocuments shortens on a character boundary', () => {
  const [change] = diffDocuments({ note: 'a' }, { note: 'é'.repeat(300) })
  expect(byteLength(change?.after ?? null)).toBeLessThanOrEqual(200)
  expect(change?.after?.includes('�')).toBe(false)
})

test('diffDocuments gives a short multi-line text a line summary too', () => {
  const [change] = diffDocuments({ system: 'a\nb' }, { system: 'a\nc' })
  expect(change?.lines).toEqual({ added: 1, removed: 1 })
})

test('diffDocuments gives no line summary to a short single-line text', () => {
  const [change] = diffDocuments({ name: 'old' }, { name: 'new' })
  expect(change).toEqual({ path: 'name', before: 'old', after: 'new', lines: null })
})

test('diffDocuments gives one line for a subtree present on one side only', () => {
  expect(diffDocuments({ list: [1] }, { list: [1, { a: 1, b: 2 }] })).toEqual([
    { path: 'list[1]', before: null, after: '{"a":1,"b":2}', lines: null }
  ])
})

test('diffDocuments gives one line per added server and tool entry, not a dozen', () => {
  const before = { mcp_servers: [{ name: 'a' }], tools: [{ type: 'agent_toolset' }, { type: 'mcp_toolset', mcp_server_name: 'a' }] }
  const after = {
    mcp_servers: [{ name: 'a' }, { name: 'b', url: 'https://example.test', type: 'url' }],
    tools: [...before.tools, { type: 'mcp_toolset', mcp_server_name: 'b', default_config: { permission_policy: { type: 'always_ask' } } }]
  }
  expect(diffDocuments(before, after).map((change) => change.path)).toEqual(['mcp_servers[1]', 'tools[2]'])
})

test('diffDocuments walks nested paths through objects and arrays', () => {
  const before = { tools: [{ type: 'a' }, { type: 'b', default_config: { permission_policy: { type: 'always_allow' } } }] }
  const after = { tools: [{ type: 'a' }, { type: 'b', default_config: { permission_policy: { type: 'always_ask' } } }] }
  expect(diffDocuments(before, after)).toEqual([
    { path: 'tools[1].default_config.permission_policy.type', before: 'always_allow', after: 'always_ask', lines: null }
  ])
})

test('diffDocuments lists removed keys after the kept ones', () => {
  expect(diffDocuments({ gone: { deep: 1 }, kept: 1, dropped: 'x' }, { kept: 2 })).toEqual([
    { path: 'kept', before: '1', after: '2', lines: null },
    { path: 'gone', before: '{"deep":1}', after: null, lines: null },
    { path: 'dropped', before: 'x', after: null, lines: null }
  ])
})

test('diffDocuments writes a non-string leaf as JSON and tells null from a missing key', () => {
  expect(diffDocuments({ a: null, b: 'x' }, { a: 0, b: ['x'] })).toEqual([
    { path: 'a', before: 'null', after: '0', lines: null },
    { path: 'b', before: 'x', after: '["x"]', lines: null }
  ])
})

test('summarizeLines compares lines as multisets', () => {
  expect(summarizeLines('a\nb\nb', 'b\nc\nc\nb')).toEqual({ added: 2, removed: 1 })
  expect(summarizeLines('same', 'same')).toEqual({ added: 0, removed: 0 })
  // Un texte vide n'a aucune ligne.
  expect(summarizeLines('', 'one\ntwo')).toEqual({ added: 2, removed: 0 })
})
