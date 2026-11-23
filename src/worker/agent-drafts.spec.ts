import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DraftRef } from '../protocol'
import { NEW_AGENT_YAML, agentToDocument, renderAgentYaml, type AgentDocument } from './agent-yaml'
import { NEW_AGENT_FILE, agentFile, createAgentAdapter, releaseArchivedDrafts, sendAgent } from './agent-drafts'
import type { ClientStore } from './client'
import { REGISTRY_FILE, createDrafts, type Drafts } from './drafts'
import type { EditorHost } from './editor-host'
import { createPendingWrites } from './pending-writes'

type AgentRef = Extract<DraftRef, { kind: 'agent' }>

// La fixture est la réponse réelle de l'API pour `Incident commander` (capturée le 22/11).
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agent.json', import.meta.url), 'utf8')) as BetaManagedAgentsAgent

const EXISTING: AgentRef = { kind: 'agent', agentId: 'agent_1' }
const NEW: AgentRef = { kind: 'agent', agentId: null }
const EXISTING_FILE = 'agents/incident-commander--agent_1.yaml'

/** Le corps réel d'un refus de version, capturé le 22/11 (docs/superpowers/runs/lot2/t12-version-probe.log). */
const VERSION_REFUSAL_BODY = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Concurrent modification detected. Please fetch the latest version and retry.' },
  request_id: 'req_test'
}
const conflictError = (body: object): Error => new Anthropic.ConflictError(409, body, undefined, new Headers())

const dirs: string[] = []
function tempFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'cma-agent-drafts-'))
  dirs.push(root)
  const folder = join(root, 'managed-agents')
  mkdirSync(folder)
  return folder
}

function cleanup(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Le focus d'Orca se règle à la main : c'est lui que `open` lit pour le workspace de retour. */
function fakeHost(folder: string) {
  const calls: string[] = []
  const focus = { workspaceId: 'ws-other', name: 'my-project' }
  const host: EditorHost = {
    async folders() {
      return [{ id: 'ws-drafts', name: 'managed-agents', path: realpathSync(folder) }]
    },
    async focused() {
      return { ...focus }
    },
    async show(workspaceId) {
      calls.push(`show ${workspaceId}`)
    },
    async open(workspaceId, path) {
      calls.push(`open ${workspaceId} ${path}`)
    }
  }
  return { host, calls, focus }
}

type Call = { method: string; args: unknown[] }
type AgentRecord = Record<string, unknown> & { id: string; version: number }

const notFound = (id: string): Error =>
  new Anthropic.NotFoundError(404, { type: 'error', error: { type: 'not_found_error', message: `no agent ${id}` } }, undefined, new Headers())

/** Faux client des agents : une garde de version comme celle de l'API, et la forme des réponses (effort en objet). */
function fakeApi() {
  const calls: Call[] = []
  const state = {
    agents: new Map<string, AgentRecord>(),
    /** Les versions passées (`<id>@<version>`), que `retrieve(id, { version })` relit ; vide : la rétention les a perdues. */
    history: new Map<string, AgentRecord>(),
    updateError: null as Error | null,
    /** Un geste de Romain pendant que l'envoi est en vol. */
    duringSend: null as (() => void) | null,
    nextId: 'agent_new'
  }
  state.agents.set('agent_1', { ...structuredClone(fixture), id: 'agent_1' } as unknown as AgentRecord)
  const normalizeModel = (model: unknown): unknown => {
    const config: Record<string, unknown> = typeof model === 'string' ? { id: model } : { ...(model as Record<string, unknown>) }
    if (typeof config.effort === 'string') config.effort = { type: config.effort }
    return { speed: 'standard', ...config }
  }
  const agents = {
    retrieve: async (id: string, params?: { version?: number }) => {
      calls.push({ method: 'agents.retrieve', args: [id, params] })
      const agent = state.agents.get(id)
      if (!agent) throw notFound(id)
      if (params?.version !== undefined && params.version !== agent.version) {
        const past = state.history.get(`${id}@${params.version}`)
        if (!past) throw notFound(`${id}@${params.version}`)
        return structuredClone(past)
      }
      return structuredClone(agent)
    },
    create: async (params: Record<string, unknown>) => {
      calls.push({ method: 'agents.create', args: [params] })
      state.duringSend?.()
      const agent: AgentRecord = {
        archived_at: null,
        created_at: 't',
        description: null,
        execution_identity: { type: 'service_account' },
        mcp_servers: [],
        metadata: {},
        multiagent: null,
        skills: [],
        system: null,
        tools: [],
        type: 'agent',
        updated_at: 't',
        ...params,
        model: normalizeModel(params.model),
        id: state.nextId,
        version: 1
      }
      state.agents.set(agent.id, agent)
      return structuredClone(agent)
    },
    update: async (id: string, params: Record<string, unknown>) => {
      calls.push({ method: 'agents.update', args: [id, params] })
      if (state.updateError) throw state.updateError
      const agent = state.agents.get(id)
      if (!agent) throw notFound(id)
      if (params.version !== undefined && params.version !== agent.version) throw conflictError(VERSION_REFUSAL_BODY)
      const { version: _version, metadata, ...rest } = params
      const next: AgentRecord = { ...agent, ...rest, version: agent.version + 1 }
      if (rest.model !== undefined) next.model = normalizeModel(rest.model)
      if (metadata !== undefined) {
        const merged = { ...(agent.metadata as Record<string, string>) }
        for (const [key, value] of Object.entries(metadata as Record<string, string | null>)) {
          if (value === null) delete merged[key]
          else merged[key] = value
        }
        next.metadata = merged
      }
      state.history.set(`${id}@${agent.version}`, structuredClone(agent))
      state.agents.set(id, next)
      return structuredClone(next)
    }
  }
  const store = { get: async () => ({ beta: { agents } }), reset() {}, hasKey: async () => true } as unknown as ClientStore
  return { store, state, calls }
}

function setup() {
  const folder = tempFolder()
  const fake = fakeHost(folder)
  const api = fakeApi()
  const pending = createPendingWrites(() => 0)
  const logs: string[] = []
  const holder: { drafts?: Drafts } = {}
  const adapter = createAgentAdapter(api.store, () => holder.drafts as Drafts, (message) => logs.push(message), () => new Date('2026-11-22T10:00:00.000Z'))
  const drafts = createDrafts({
    folder,
    host: fake.host,
    adapters: { agent: adapter },
    pending,
    now: () => new Date('2026-11-22T10:00:00.000Z'),
    log: (message) => logs.push(message)
  })
  holder.drafts = drafts
  /** Le geste du panneau : `draft.prepare` puis `write.commit`. */
  const apply = async (ref: DraftRef, force = false) => {
    const prepared = await drafts.prepare(ref)
    return prepared.ok ? pending.commit(prepared.value.token, force) : prepared
  }
  const registry = () =>
    JSON.parse(readFileSync(join(folder, REGISTRY_FILE), 'utf8')) as {
      entries: Record<string, { ref: DraftRef; base: unknown; returnTo: { workspaceId: string } | null }>
    }
  const read = (file: string): string => readFileSync(join(folder, file), 'utf8')
  /** L'édition de Romain : une valeur remplacée dans le texte du fichier. */
  const edit = (file: string, from: string, to: string): void => {
    const text = read(file)
    expect(text.includes(from)).toBe(true)
    writeFileSync(join(folder, file), text.replace(from, to))
  }
  /** Un autre éditeur (la console) modifie l'agent : une mise à jour sans garde, qui monte la version. */
  const elsewhere = async (patch: Record<string, unknown>): Promise<void> => {
    const client = (await api.store.get()) as unknown as { beta: { agents: { update: (id: string, params: unknown) => Promise<unknown> } } }
    await client.beta.agents.update('agent_1', patch)
    api.calls.pop()
  }
  return { folder, fake, api, pending, logs, drafts, apply, registry, read, edit, elsewhere }
}

const only = (calls: Call[], method: string): Call[] => calls.filter((call) => call.method === method)

test('agentFile names the file by slug and id, and the new agent has a fixed file', () => {
  expect(agentFile('Incident commander', 'agent_1')).toBe(EXISTING_FILE)
  expect(agentFile('Weird & Name!!', 'agent_2')).toBe('agents/weird-name--agent_2.yaml')
  expect(NEW_AGENT_FILE).toBe('agents/new-agent.yaml')
})

test('open writes the live agent as YAML under its slug and id, with the header, and records the version as the base', async () => {
  const { drafts, read, registry, fake } = setup()
  const result = await drafts.open(EXISTING)
  expect(result.ok && result.value.file).toBe(EXISTING_FILE)
  const expected = renderAgentYaml(agentToDocument(fixture), { id: 'agent_1', version: 5, readAt: '2026-11-22T10:00:00.000Z' })
  expect(read(EXISTING_FILE)).toBe(expected)
  expect(read(EXISTING_FILE).startsWith('# Agent agent_1 · version 5 · read 2026-11-22T10:00:00.000Z\n# Edit, save (⌘S)')).toBe(true)
  expect(registry().entries[EXISTING_FILE]?.base).toEqual({ version: 5 })
  expect(fake.calls).toEqual(['show ws-drafts', `open ws-drafts ${EXISTING_FILE}`])
  cleanup()
})

test('open of a new agent writes the blank template, with no base, and has nothing to apply until it is edited', async () => {
  const { drafts, read, registry, apply, api } = setup()
  const result = await drafts.open(NEW)
  expect(result.ok && result.value.file).toBe(NEW_AGENT_FILE)
  expect(read(NEW_AGENT_FILE)).toBe(NEW_AGENT_YAML)
  expect(registry().entries[NEW_AGENT_FILE]?.base).toBe(null)
  expect(await apply(NEW)).toEqual({ ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: save the file first (⌘S).' })
  expect(api.calls).toEqual([])
  cleanup()
})

test('a draft keeps its file name when the agent is renamed', async () => {
  const { drafts, api, registry, folder } = setup()
  ;(api.state.agents.get('agent_1') as AgentRecord).name = 'Old name'
  const first = await drafts.open(EXISTING)
  expect(first.ok && first.value.file).toBe('agents/old-name--agent_1.yaml')
  ;(api.state.agents.get('agent_1') as AgentRecord).name = 'New name'
  const second = await drafts.open(EXISTING)
  expect(second.ok && second.value.file).toBe('agents/old-name--agent_1.yaml')
  expect(readdirSync(join(folder, 'agents'))).toEqual(['old-name--agent_1.yaml'])
  expect(Object.keys(registry().entries)).toEqual(['agents/old-name--agent_1.yaml'])
  // Le contenu relu porte le nouveau nom ; le fichier reste celui d'origine.
  expect(readFileSync(join(folder, 'agents/old-name--agent_1.yaml'), 'utf8').includes('name: New name\n')).toBe(true)
  cleanup()
})

test('an edited draft of a renamed agent is still found and applied', async () => {
  const { drafts, api, apply, edit } = setup()
  ;(api.state.agents.get('agent_1') as AgentRecord).name = 'Old name'
  await drafts.open(EXISTING)
  ;(api.state.agents.get('agent_1') as AgentRecord).name = 'New name'
  edit('agents/old-name--agent_1.yaml', 'Be decisive.', 'Be calm.')
  expect((await apply(EXISTING, true)).ok).toBe(true)
  cleanup()
})

test('an update carries the version of the base, and only the top-level keys that changed', async () => {
  const { drafts, apply, edit, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  const committed = await apply(EXISTING)
  expect(committed).toEqual({ ok: true, value: { label: 'Applied, v6', id: 'agent_1' } })
  const [update] = only(api.calls, 'agents.update')
  expect(update?.args[0]).toBe('agent_1')
  const params = update?.args[1] as Record<string, unknown>
  expect(Object.keys(params).sort()).toEqual(['system', 'version'])
  expect(params.version).toBe(5)
  expect(String(params.system).includes('Be calm.')).toBe(true)
  cleanup()
})

test('a forced update sends no version at all', async () => {
  const { drafts, apply, edit, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  expect((await apply(EXISTING, true)).ok).toBe(true)
  const params = only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>
  expect('version' in params).toBe(false)
  expect(Object.keys(params)).toEqual(['system'])
  cleanup()
})

test('AC-6: a key changed elsewhere and untouched in the file is neither previewed nor sent, guarded or forced', async () => {
  const { drafts, pending, edit, elsewhere, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  // La console change `description` : v5 -> v6, alors que le fichier a été lu en v5.
  await elsewhere({ description: 'Changed in the console' })
  const prepared = await drafts.prepare(EXISTING)
  if (!prepared.ok) throw new Error('prepare failed')
  // L'aperçu compare le fichier à ce que Romain a ouvert (v5) : seul `system` y figure.
  expect(prepared.value.changes.map((change) => change.path)).toEqual(['system'])
  expect(prepared.value.totalChanges).toBe(1)
  expect(only(api.calls, 'agents.retrieve').some((call) => (call.args[1] as { version?: number } | undefined)?.version === 5)).toBe(true)

  // Le refus de version nomme les deux versions, le fichier et le jeton restent.
  const refused = await pending.commit(prepared.value.token, false)
  expect(refused).toEqual({ ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it (v5 → v6).' })
  expect(Object.keys(only(api.calls, 'agents.update')[0]?.args[1] as object).sort()).toEqual(['system', 'version'])

  // « Apply anyway » : seul `system` part, `description` de la console reste.
  const forced = await pending.commit(prepared.value.token, true)
  expect(forced.ok).toBe(true)
  const params = only(api.calls, 'agents.update')[1]?.args[1] as Record<string, unknown>
  expect(Object.keys(params)).toEqual(['system'])
  expect((api.state.agents.get('agent_1') as AgentRecord).description).toBe('Changed in the console')
  expect(String((api.state.agents.get('agent_1') as AgentRecord).system).includes('Be calm.')).toBe(true)
  cleanup()
})

test('a key changed in the file and elsewhere is sent with the file value when forced', async () => {
  const { drafts, pending, edit, elsewhere, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'description: Triages incident ticket', 'description: Mine')
  await elsewhere({ description: 'Theirs' })
  const prepared = await drafts.prepare(EXISTING)
  if (!prepared.ok) throw new Error('prepare failed')
  expect(prepared.value.changes.map((change) => change.path)).toEqual(['description'])
  expect((await pending.commit(prepared.value.token, true)).ok).toBe(true)
  expect((api.state.agents.get('agent_1') as AgentRecord).description).toBe('Mine')
  cleanup()
})

test('when the opened version cannot be read back (404), the preview falls back to the live version and says so in the log', async () => {
  const { drafts, pending, edit, elsewhere, api, logs } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  await elsewhere({ description: 'Changed in the console' })
  api.state.history.clear()
  const prepared = await drafts.prepare(EXISTING)
  if (!prepared.ok) throw new Error('prepare failed')
  // Repli : la version vivante sert de référence, la différence de `description` réapparaît.
  expect(prepared.value.changes.map((change) => change.path).sort()).toEqual(['description', 'system'])
  expect(logs.some((line) => line.includes('v5') && line.includes('live'))).toBe(true)
  // Le refus de version nomme toujours les deux versions.
  expect(await pending.commit(prepared.value.token, false)).toEqual({
    ok: false,
    code: 'conflict',
    error: 'Changed elsewhere since you opened it (v5 → v6).'
  })
  cleanup()
})

test('when the live version is the one that was opened, no second read is made', async () => {
  const { drafts, apply, edit, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  expect((await apply(EXISTING)).ok).toBe(true)
  expect(only(api.calls, 'agents.retrieve').filter((call) => call.args[1] !== undefined)).toEqual([])
  cleanup()
})

test('a file that matches the version you opened has nothing to apply even when the agent moved on', async () => {
  const { drafts, apply, read, elsewhere, folder } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), `# a note of mine\n${read(EXISTING_FILE)}`)
  await elsewhere({ description: 'Changed in the console' })
  expect(await apply(EXISTING)).toEqual({ ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: the file matches the version you opened.' })
  cleanup()
})

test('after an update the file is rewritten from the response, with the new version as header and base', async () => {
  const { drafts, apply, edit, read, registry, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  await apply(EXISTING)
  const live = api.state.agents.get('agent_1') as unknown as BetaManagedAgentsAgent
  expect(live.version).toBe(6)
  expect(read(EXISTING_FILE)).toBe(renderAgentYaml(agentToDocument(live), { id: 'agent_1', version: 6, readAt: '2026-11-22T10:00:00.000Z' }))
  expect(registry().entries[EXISTING_FILE]?.base).toEqual({ version: 6 })
  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.unapplied).toBe(false)
  cleanup()
})

test('a version refusal in the captured shape is a conflict that names both versions, keeps the file and the token', async () => {
  const { drafts, pending, edit, read, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  const prepared = await drafts.prepare(EXISTING)
  if (!prepared.ok) throw new Error('prepare failed')
  // Quelqu'un d'autre a modifié l'agent entre-temps : v5 -> v7.
  ;(api.state.agents.get('agent_1') as AgentRecord).version = 7
  expect(await pending.commit(prepared.value.token, false)).toEqual({
    ok: false,
    code: 'conflict',
    error: 'Changed elsewhere since you opened it (v5 → v7).'
  })
  expect(read(EXISTING_FILE).includes('Be calm.')).toBe(true)
  const state = await drafts.state(EXISTING)
  expect(state.ok && state.value?.unapplied).toBe(true)

  // « Apply anyway » : même jeton, sans version.
  const forced = await pending.commit(prepared.value.token, true)
  expect(forced).toEqual({ ok: true, value: { label: 'Applied, v8', id: 'agent_1' } })
  cleanup()
})

test('any other 409 keeps the API message and is not a conflict', async () => {
  const { drafts, apply, edit, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  api.state.updateError = conflictError({ type: 'error', error: { type: 'invalid_request_error', message: 'The name is already in use.' } })
  expect(await apply(EXISTING)).toEqual({ ok: false, code: 'other', error: 'API error 409: The name is already in use.' })
  // Le même texte de refus sous un autre statut n'est pas la forme capturée.
  api.state.updateError = new Anthropic.BadRequestError(400, VERSION_REFUSAL_BODY, undefined, new Headers())
  const other = await apply(EXISTING)
  expect(!other.ok && other.code).toBe('other')
  cleanup()
})

test('an invalid YAML file answers invalid with the position, and nothing is sent', async () => {
  const { drafts, apply, folder, api } = setup()
  await drafts.open(EXISTING)
  writeFileSync(join(folder, EXISTING_FILE), 'name: x\nmodel: [\n')
  expect(await apply(EXISTING)).toEqual({
    ok: false,
    code: 'invalid',
    error: 'YAML error at line 3, column 1: Flow sequence in block collection must be sufficiently indented and end with a ]'
  })
  expect(only(api.calls, 'agents.update')).toEqual([])
  writeFileSync(join(folder, EXISTING_FILE), 'name: x\n')
  expect(await apply(EXISTING)).toEqual({ ok: false, code: 'invalid', error: 'model is required.' })
  cleanup()
})

test('a saved file that matches the live version has nothing to apply', async () => {
  const { drafts, apply, read, folder, api } = setup()
  await drafts.open(EXISTING)
  // Un commentaire de plus : le fichier a changé, l'agent pas.
  writeFileSync(join(folder, EXISTING_FILE), `# a note of mine\n${read(EXISTING_FILE)}`)
  expect(await apply(EXISTING)).toEqual({ ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: the file matches the version you opened.' })
  expect(only(api.calls, 'agents.update')).toEqual([])
  cleanup()
})

test('a draft with no recorded version is never sent unguarded', async () => {
  const { drafts, apply, edit, folder, registry, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, 'Be decisive.', 'Be calm.')
  const lost = registry()
  lost.entries[EXISTING_FILE]!.base = null
  writeFileSync(join(folder, REGISTRY_FILE), JSON.stringify(lost))
  expect(await apply(EXISTING)).toEqual({ ok: false, code: 'other', error: 'The draft file is gone: open it again.' })
  expect(only(api.calls, 'agents.update')).toEqual([])
  cleanup()
})

test('a metadata key removed in the file leaves as a null patch, never as metadata: null', async () => {
  const { drafts, apply, edit, api } = setup()
  await drafts.open(EXISTING)
  edit(EXISTING_FILE, '  template: incident-commander\n', '')
  expect((await apply(EXISTING)).ok).toBe(true)
  const params = only(api.calls, 'agents.update')[0]?.args[1] as Record<string, unknown>
  expect(params).toEqual({ metadata: { template: null }, version: 5 })
  cleanup()
})

test('creating from the template sends the document, writes the canonical file and puts the template back', async () => {
  const { drafts, apply, edit, read, registry, api, fake } = setup()
  await drafts.open(NEW)
  edit(NEW_AGENT_FILE, 'name: Untitled agent', 'name: My agent')
  fake.calls.length = 0
  const committed = await apply(NEW)
  expect(committed).toEqual({ ok: true, value: { label: 'Applied, v1', id: 'agent_new' } })

  const [create] = only(api.calls, 'agents.create')
  const params = create?.args[0] as AgentDocument
  expect(params.name).toBe('My agent')
  expect(params.model).toEqual({ id: 'claude-opus-5-5', effort: 'low' })
  expect('version' in params).toBe(false)

  const canonical = 'agents/my-agent--agent_new.yaml'
  const created = api.state.agents.get('agent_new') as unknown as BetaManagedAgentsAgent
  expect(read(canonical)).toBe(renderAgentYaml(agentToDocument(created), { id: 'agent_new', version: 1, readAt: '2026-11-22T10:00:00.000Z' }))
  expect(registry().entries[canonical]?.ref).toEqual({ kind: 'agent', agentId: 'agent_new' })
  expect(registry().entries[canonical]?.base).toEqual({ version: 1 })
  // Le modèle revient à son état d'origine, propre.
  expect(read(NEW_AGENT_FILE)).toBe(NEW_AGENT_YAML)
  const state = await drafts.state(NEW)
  expect(state.ok && state.value?.unapplied).toBe(false)
  // Le fichier canonique s'ouvre dans l'éditeur.
  expect(fake.calls).toEqual(['show ws-drafts', `open ws-drafts ${canonical}`])
  cleanup()
})

test('the canonical file inherits the return workspace of the template entry, not the last one seen', async () => {
  const { drafts, apply, edit, registry, fake } = setup()
  fake.focus.workspaceId = 'ws-A'
  fake.focus.name = 'project-a'
  await drafts.open(NEW)
  // Un autre brouillon s'ouvre depuis un autre workspace : le dernier workspace vu devient B.
  fake.focus.workspaceId = 'ws-B'
  fake.focus.name = 'project-b'
  await drafts.open(EXISTING)
  // Au moment de l'envoi, le focus est celui des brouillons.
  fake.focus.workspaceId = 'ws-drafts'
  fake.focus.name = 'managed-agents'
  edit(NEW_AGENT_FILE, 'name: Untitled agent', 'name: My agent')
  expect((await apply(NEW)).ok).toBe(true)
  expect(registry().entries['agents/my-agent--agent_new.yaml']?.returnTo).toEqual({ workspaceId: 'ws-A', name: 'project-a' })
  cleanup()
})

test('a template saved again during the creation keeps its newer text, and the canonical file is still written', async () => {
  const { drafts, apply, edit, read, folder, api } = setup()
  await drafts.open(NEW)
  edit(NEW_AGENT_FILE, 'name: Untitled agent', 'name: My agent')
  // Romain sauvegarde autre chose pendant l'envoi.
  api.state.duringSend = () => writeFileSync(join(folder, NEW_AGENT_FILE), `${read(NEW_AGENT_FILE)}# later thought\n`)
  const committed = await apply(NEW)
  expect(committed.ok).toBe(true)
  expect(read(NEW_AGENT_FILE).includes('# later thought')).toBe(true)
  expect(existsSync(join(folder, 'agents/my-agent--agent_new.yaml'))).toBe(true)
  const state = await drafts.state(NEW)
  expect(state.ok && state.value?.unapplied).toBe(true)
  cleanup()
})

test('sendAgent updates with the version unless forced, and creates from the document when there is no agent id', async () => {
  const api = fakeApi()
  const client = await api.store.get()
  const before: AgentDocument = agentToDocument(fixture)
  const after: AgentDocument = { ...before, description: 'changed' }
  const updated = await sendAgent(client, 'agent_1', 5, before, after, false)
  expect(updated.version).toBe(6)
  expect(only(api.calls, 'agents.update')[0]?.args).toEqual(['agent_1', { description: 'changed', version: 5 }])
  await sendAgent(client, 'agent_1', 6, after, { ...after, description: 'again' }, true)
  expect(only(api.calls, 'agents.update')[1]?.args).toEqual(['agent_1', { description: 'again' }])

  const created = await sendAgent(client, null, null, {}, { name: 'a', model: 'claude-haiku-5-5' }, false)
  expect(created.version).toBe(1)
  expect(only(api.calls, 'agents.create')[0]?.args).toEqual([{ name: 'a', model: 'claude-haiku-5-5' }])
})

test('m4: archiving an agent releases its clean draft, keeps and logs an unapplied one, and leaves every other draft alone', async () => {
  const { drafts, api, folder, registry, edit, logs } = setup()
  api.state.agents.set('agent_2', { ...structuredClone(fixture), id: 'agent_2', name: 'Second' } as unknown as AgentRecord)
  await drafts.open(EXISTING)
  await drafts.open({ kind: 'agent', agentId: 'agent_2' })
  await drafts.open(NEW)
  await releaseArchivedDrafts({ kind: 'agent', id: 'agent_1' }, () => drafts, (message) => logs.push(message))
  expect(existsSync(join(folder, EXISTING_FILE))).toBe(false)
  expect(Object.keys(registry().entries).sort()).toEqual([NEW_AGENT_FILE, 'agents/second--agent_2.yaml'])
  // Un brouillon modifié et non appliqué reste, et le journal le dit.
  edit('agents/second--agent_2.yaml', 'Be decisive.', 'Be calm.')
  await releaseArchivedDrafts({ kind: 'agent', id: 'agent_2' }, () => drafts, (message) => logs.push(message))
  expect(existsSync(join(folder, 'agents/second--agent_2.yaml'))).toBe(true)
  expect(logs.some((message) => message.includes('agent draft kept') && message.includes('agents/second--agent_2.yaml'))).toBe(true)
  // Le modèle du nouvel agent n'est jamais celui d'un agent archivé ; un autre type de ressource est sans effet.
  expect(existsSync(join(folder, NEW_AGENT_FILE))).toBe(true)
  await releaseArchivedDrafts({ kind: 'environment', id: 'env_1' }, () => drafts, (message) => logs.push(message))
  expect(Object.keys(registry().entries).sort()).toEqual([NEW_AGENT_FILE, 'agents/second--agent_2.yaml'])
  cleanup()
})

test('m4: a draft that cannot be released does not make the archive fail, and says so in the log', async () => {
  const { drafts, logs } = setup()
  const broken = { ...drafts, release: async () => Promise.reject(new Error('disk full')) } as unknown as Drafts
  await releaseArchivedDrafts({ kind: 'agent', id: 'agent_1' }, () => broken, (message) => logs.push(message))
  expect(logs.some((message) => message.includes('agent drafts not released') && message.includes('disk full'))).toBe(true)
  cleanup()
})
