import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { diffDocuments } from './diff'
import {
  AGENT_KEY_ORDER,
  NEW_AGENT_YAML,
  agentToDocument,
  changedTopLevel,
  parseAgentYaml,
  renderAgentYaml,
  type AgentDocument
} from './agent-yaml'

// La fixture est la réponse réelle de l'API pour `Incident commander` (capturée le 22/11).
const agent = JSON.parse(readFileSync(new URL('./fixtures/agent.json', import.meta.url), 'utf8')) as BetaManagedAgentsAgent

const DROPPED = ['archived_at', 'created_at', 'execution_identity', 'id', 'type', 'updated_at', 'version', 'multiagent']

function expectDocument(text: string): AgentDocument {
  const parsed = parseAgentYaml(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.doc
}

test('the rendered fixture reads back as the fixture without the seven dropped keys and the null multiagent', () => {
  const rendered = renderAgentYaml(agentToDocument(agent), null)
  const expected: Record<string, unknown> = { ...(agent as unknown as Record<string, unknown>) }
  for (const key of DROPPED) delete expected[key]
  expect(parse(rendered)).toEqual(expected)
  expect(Object.keys(parse(rendered) as object)).toEqual(['name', 'model', 'description', 'system', 'mcp_servers', 'tools', 'skills', 'metadata'])
  expect(AGENT_KEY_ORDER).toEqual(['name', 'model', 'description', 'system', 'mcp_servers', 'tools', 'skills', 'multiagent', 'metadata'])
})

test('the document keeps the response shape of the model and of the tool configs', () => {
  const doc = agentToDocument(agent)
  expect(doc.model).toEqual({ id: 'claude-haiku-5-5', effort: { type: 'high' }, speed: 'standard' })
  const rendered = renderAgentYaml(doc, null)
  expect(rendered.includes('effort:\n    type: high\n')).toBe(true)
  expect(rendered.includes('url_sources: null\n')).toBe(true)
})

test('a multiagent block that is not null stays, in its place before metadata', () => {
  const withRoster = { ...agent, multiagent: { type: 'coordinator', agents: [{ type: 'self' }] } } as unknown as BetaManagedAgentsAgent
  expect(Object.keys(agentToDocument(withRoster))).toEqual(['name', 'model', 'description', 'system', 'mcp_servers', 'tools', 'skills', 'multiagent', 'metadata'])
})

test('a response key outside the known order follows alphabetically, so none is lost silently', () => {
  const extended = { ...agent, zeta: 1, alpha: { a: true } } as unknown as BetaManagedAgentsAgent
  expect(Object.keys(agentToDocument(extended))).toEqual([
    'name',
    'model',
    'description',
    'system',
    'mcp_servers',
    'tools',
    'skills',
    'metadata',
    'alpha',
    'zeta'
  ])
})

test('the header is two exact comment lines and does not change what the file means', () => {
  const doc = agentToDocument(agent)
  const rendered = renderAgentYaml(doc, { id: 'agent_1', version: 5, readAt: '2026-11-22T10:00:00.000Z' })
  expect(rendered.split('\n').slice(0, 2)).toEqual([
    '# Agent agent_1 · version 5 · read 2026-11-22T10:00:00.000Z',
    '# Edit, save (⌘S), then press Apply in the Managed Agents panel.'
  ])
  expect(parse(rendered)).toEqual(parse(renderAgentYaml(doc, null)))
})

test('the system prompt round-trips byte for byte, with or without a final newline', () => {
  const prompts = [
    'line one\nline two\n',
    'line one\nline two',
    '',
    'single line',
    '  indented first line\nsecond\n',
    'trailing blank lines\n\n\n',
    '\nleading newline',
    'colon: here # and a hash\n- not a list\n',
    'tab\there\nwindows\r\nline',
    "quote ' and \" and \\ backslash\n",
    'émoji ✨ and accents é\n',
    `${'a very long line '.repeat(30)}\nend`
  ]
  for (const system of prompts) {
    const rendered = renderAgentYaml({ ...agentToDocument(agent), system }, null)
    expect(expectDocument(rendered).system).toBe(system)
  }
})

test('a prompt with several lines is written as a literal block, not one escaped line', () => {
  const rendered = renderAgentYaml({ name: 'a', model: 'claude-haiku-5-5', system: 'line one\nline two\n' }, null)
  expect(rendered.includes('system: |\n  line one\n  line two\n')).toBe(true)
})

test('rendering then parsing an untouched agent leaves nothing to apply', () => {
  const doc = agentToDocument(agent)
  const rendered = renderAgentYaml(doc, { id: agent.id, version: agent.version, readAt: 'now' })
  expect(diffDocuments(doc, expectDocument(rendered))).toEqual([])
  expect(changedTopLevel(doc, expectDocument(rendered))).toEqual({})
})

test('a syntax error names the line and the column, exactly', () => {
  expect(parseAgentYaml('name: x\nmodel: [\n')).toEqual({
    ok: false,
    error: 'YAML error at line 3, column 1: Flow sequence in block collection must be sufficiently indented and end with a ]'
  })
})

test('a duplicate key is a syntax error with a position', () => {
  const result = parseAgentYaml('name: x\nname: y\nmodel: a\n')
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error.startsWith('YAML error at line 2, column 1: ')).toBe(true)
})

test('a file that is not a mapping, or lacks name or model, is refused in words', () => {
  for (const text of ['', '- a\n- b\n', 'just text\n', '42\n', 'null\n']) {
    expect(parseAgentYaml(text)).toEqual({ ok: false, error: 'The file must be a YAML mapping.' })
  }
  expect(parseAgentYaml('model: claude-haiku-5-5\n')).toEqual({ ok: false, error: 'name is required.' })
  expect(parseAgentYaml('name: x\n')).toEqual({ ok: false, error: 'model is required.' })
  expect(parseAgentYaml('name: ""\nmodel: a\n')).toEqual({ ok: false, error: 'name is required.' })
  expect(parseAgentYaml('name: x\nmodel: null\n')).toEqual({ ok: false, error: 'model is required.' })
})

test('a file made of only a comment header is not a mapping', () => {
  expect(parseAgentYaml('# Agent agent_1 · version 5\n# Edit, save\n')).toEqual({ ok: false, error: 'The file must be a YAML mapping.' })
})

test('the blank agent template parses to a valid document', () => {
  const doc = expectDocument(NEW_AGENT_YAML)
  expect(doc).toEqual({
    name: 'Untitled agent',
    description: 'A blank starting point with the core toolset.',
    model: { id: 'claude-opus-5-5', effort: 'low' },
    system:
      "You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user's task end to end.",
    mcp_servers: [],
    tools: [{ type: 'agent_toolset_20260401', default_config: { permission_policy: { type: 'auto' } } }],
    skills: []
  })
})

test('only the top-level keys that differ are returned, a removed key becomes null', () => {
  const before = agentToDocument(agent)
  const after = { ...before, system: 'new prompt', description: 'changed' } as AgentDocument
  expect(changedTopLevel(before, after)).toEqual({ system: 'new prompt', description: 'changed' })

  const { description: _removed, ...without } = before
  expect(changedTopLevel(before, without)).toEqual({ description: null })
})

test('a nested change sends the whole top-level value', () => {
  const before = agentToDocument(agent)
  const model = { ...(before.model as object), effort: { type: 'low' } }
  expect(changedTopLevel(before, { ...before, model })).toEqual({ model })
})

test('removing the template key from the metadata sends it as a null patch', () => {
  const before = agentToDocument(agent)
  const text = renderAgentYaml(before, null).replace('  template: incident-commander\n', '')
  expect(text.includes('template')).toBe(false)
  expect(changedTopLevel(before, expectDocument(text))).toEqual({ metadata: { template: null } })
})

test('removing the whole metadata block sends the same patch, never metadata: null', () => {
  const before = agentToDocument(agent)
  const { metadata: _removed, ...without } = before
  expect(changedTopLevel(before, without)).toEqual({ metadata: { template: null } })
  expect(changedTopLevel(before, { ...without, metadata: null })).toEqual({ metadata: { template: null } })
  expect(changedTopLevel(before, { ...without, metadata: {} })).toEqual({ metadata: { template: null } })
})

test('a metadata edit sends only the added, changed and removed keys', () => {
  const before: AgentDocument = { name: 'a', model: 'm', metadata: { keep: '1', change: 'old', drop: 'x' } }
  const after: AgentDocument = { name: 'a', model: 'm', metadata: { keep: '1', change: 'new', add: 'y' } }
  expect(changedTopLevel(before, after)).toEqual({ metadata: { change: 'new', add: 'y', drop: null } })
  // Une métadonnée identique ne part pas.
  expect(changedTopLevel(before, { ...before })).toEqual({})
})

test('metadata added to an agent that had none is sent as it is', () => {
  const before: AgentDocument = { name: 'a', model: 'm' }
  expect(changedTopLevel(before, { ...before, metadata: { team: 'ops' } })).toEqual({ metadata: { team: 'ops' } })
  // Aucune métadonnée vivante et le fichier n'en veut pas : rien à envoyer, jamais `metadata: null`.
  expect(changedTopLevel(before, { ...before, metadata: null })).toEqual({})
})
