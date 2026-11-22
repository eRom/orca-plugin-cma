import { read, update } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { ConfigKind, ConfigRow, CredentialForm, CredentialRow, SaveInput, VaultDetail, VaultForm } from '../protocol'
import * as panel from '../panel'
import { formDrafts, secretDrafts } from './form-state'
import { nav, notice, popView } from './state'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org'
}

const CONFLICT = { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' } as const

/** Un jeton de test sous forme non hexadécimale : un hexadécimal de 32 caractères serait masqué à l'affichage. */
const TOKEN = 'plugin-test-token-QUOKKA'

const T0 = '2026-11-21T09:00:00Z'
const T1 = '2026-11-22T10:00:00Z'

const BEARER_FORM: CredentialForm = { type: 'static_bearer', name: 'GitHub bearer', mcpServerUrl: 'https://api.githubcopilot.com/mcp/', token: '' }
const ENV_FORM: CredentialForm = {
  type: 'environment_variable',
  name: 'Deploy token',
  secretName: 'DEPLOY_TOKEN',
  secretValue: '',
  network: { mode: 'limited', allowedHosts: ['example.com'] },
  injection: { header: true, body: false }
}

const BEARER_ROW: CredentialRow = {
  id: 'vcrd_bearer',
  name: 'GitHub bearer',
  type: 'static_bearer',
  mcpServerUrl: BEARER_FORM.type === 'static_bearer' ? BEARER_FORM.mcpServerUrl : null,
  expiresAt: null,
  updatedAt: T1,
  form: BEARER_FORM
}
const ENV_ROW: CredentialRow = {
  id: 'vcrd_env',
  name: 'Deploy token',
  type: 'environment_variable',
  mcpServerUrl: null,
  expiresAt: null,
  updatedAt: T1,
  form: ENV_FORM
}
const OAUTH_ROW: CredentialRow = {
  id: 'vcrd_oauth',
  name: 'GitHub OAuth',
  type: 'mcp_oauth',
  mcpServerUrl: 'https://api.githubcopilot.com/mcp/',
  expiresAt: '2027-01-01T00:00:00Z',
  updatedAt: T1,
  form: null
}

const VAULT: VaultDetail = {
  kind: 'vault',
  id: 'vlt_a',
  name: 'GitHub',
  updatedAt: T1,
  form: { name: 'GitHub' },
  credentials: [BEARER_ROW, ENV_ROW, OAUTH_ROW]
}

const NEW_VAULT: VaultDetail = { ...VAULT, id: 'vlt_new', name: 'plugin-test-vault', form: { name: 'plugin-test-vault' }, credentials: [] }

const ROWS: ConfigRow[] = [{ kind: 'vault', id: 'vlt_a', name: 'GitHub', summary: '3 credentials' }]

const OPEN_VAULT = { plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }] } }
const OPEN_NEW_VAULT = { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'vault' }] } }
const openCredential = (credentialId: string | null) => ({
  plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }, { view: 'credential', vaultId: 'vlt_a', credentialId }] }
})

type CredentialSave = SaveInput<CredentialForm> & { vaultId: string }

/** Les appels reçus par le faux worker, dans l'ordre. */
type Calls = {
  vaultSaves: SaveInput<VaultForm>[]
  credentialSaves: CredentialSave[]
  lists: ConfigKind[]
  details: string[]
  archives: unknown[]
  deletes: unknown[]
}

function newCalls(): Calls {
  return { vaultSaves: [], credentialSaves: [], lists: [], details: [], archives: [], deletes: [] }
}

/** Les demandes communes ; `over` remplace ou complète, `calls` garde ce que le panneau envoie. */
function requests(calls: Calls, over: Record<string, unknown> = {}) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': ({ kind }: { kind: ConfigKind }) => {
      calls.lists.push(kind)
      return { ok: true, value: kind === 'vault' ? ROWS : [] }
    },
    'configs.detail': ({ id }: { id: string }) => {
      calls.details.push(id)
      return { ok: true, value: id === 'vlt_new' ? NEW_VAULT : VAULT }
    },
    'vault.save': (input: SaveInput<VaultForm>) => {
      calls.vaultSaves.push(input)
      return { ok: true, value: { id: input.id ?? 'vlt_new', updatedAt: '2026-11-22T11:00:00Z' } }
    },
    'credential.save': (input: CredentialSave) => {
      calls.credentialSaves.push(input)
      return { ok: true, value: { id: input.id ?? 'vcrd_new', updatedAt: '2026-11-22T11:00:00Z' } }
    },
    'resource.archive': (input: unknown) => {
      calls.archives.push(input)
      return { ok: true, value: null }
    },
    'resource.delete': (input: unknown) => {
      calls.deletes.push(input)
      return { ok: true, value: null }
    },
    ...over
  } as never
}

type View = Awaited<ReturnType<typeof mount>>

const persistedText = (view: View): string => JSON.stringify(view.persisted)
const byteLength = (text: string): number => new TextEncoder().encode(text).length
const invalidOf = (view: View, label: string): unknown => view.find({ label })?.props.invalid

// --- Coffre ---

test('opens a vault with its name, its credentials and Add credential', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: OPEN_VAULT })
  assert.equal(view.valueOf({ label: 'Name' }), 'GitHub')
  assert.ok(view.find({ type: 'ListItem', label: 'GitHub bearer' }))
  assert.ok(view.find({ type: 'ListItem', label: 'GitHub OAuth' }))
  assert.ok(view.find({ role: 'button', text: 'Add credential' }))
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('renaming a vault sends vault.save against the loaded version, then rereads the list and the detail', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_VAULT })
  await view.type({ label: 'Name' }, 'Renamed', { replace: true })
  assert.ok(view.find({ text: 'Unsaved changes' }))
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.vaultSaves.length, 1)
  const sent = calls.vaultSaves[0]
  assert.ok(sent)
  assert.equal(sent.id, 'vlt_a')
  assert.equal(sent.baseUpdatedAt, VAULT.updatedAt)
  assert.equal(sent.force, false)
  assert.deepEqual(sent.base, { name: 'GitHub' })
  assert.deepEqual(sent.form, { name: 'Renamed' })
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['vlt_a', 'vlt_a'])
  assert.deepEqual(read(formDrafts), {})
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  await view.unmount()
})

test('a vault draft kept on an older version sends that older base and stamp, and shows the conflict', async () => {
  const calls = newCalls()
  const persisted = {
    plugin: {
      ...OPEN_VAULT.plugin,
      'forms.drafts': { 'vault:vlt_a': { form: { name: 'Mine' }, base: { name: 'Old name' }, baseStamp: T0 } }
    }
  }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Mine')
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.vaultSaves[0]?.baseUpdatedAt, T0)
  assert.deepEqual(calls.vaultSaves[0]?.base, { name: 'Old name' })
  assert.equal(calls.vaultSaves[0]?.force, false)
  await view.unmount()
})

test('a vault conflict offers Reload and Save anyway, and Save anyway forces the write with the draft base', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, {
      'vault.save': (input: SaveInput<VaultForm>) => {
        calls.vaultSaves.push(input)
        answers += 1
        return answers === 1 ? CONFLICT : { ok: true, value: { id: 'vlt_a', updatedAt: '2026-11-22T12:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_VAULT })
  await view.type({ label: 'Name' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.ok(view.find({ role: 'button', text: 'Reload' }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Mine')
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(calls.vaultSaves.length, 2)
  assert.equal(calls.vaultSaves[1]?.force, true)
  assert.equal(calls.vaultSaves[1]?.baseUpdatedAt, VAULT.updatedAt)
  assert.deepEqual(calls.vaultSaves[1]?.base, { name: 'GitHub' })
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('Reload after a vault conflict rereads the detail and drops the kept input', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'vault.save': CONFLICT }) })
  const view = await mount(panel, { host, persisted: OPEN_VAULT })
  await view.type({ label: 'Name' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.details, ['vlt_a', 'vlt_a'])
  assert.equal(view.valueOf({ label: 'Name' }), 'GitHub')
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a typed vault name survives a panel restart with Unsaved changes, and Discard brings the loaded name back', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_VAULT })
  await first.type({ label: 'Name' }, 'Kept', { replace: true })
  const persisted = { plugin: first.persisted.plugin }
  await first.unmount()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.equal(view.valueOf({ label: 'Name' }), 'Kept')
  assert.ok(view.find({ text: 'Unsaved changes' }))
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(view.valueOf({ label: 'Name' }), 'GitHub')
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('creates a vault and opens its detail', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_NEW_VAULT })
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  assert.equal(view.find({ role: 'button', text: 'Add credential' }), null)
  await view.type({ label: 'Name' }, 'plugin-test-vault')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.vaultSaves.length, 1)
  assert.equal(calls.vaultSaves[0]?.id, null)
  assert.equal(calls.vaultSaves[0]?.base, null)
  assert.equal(calls.vaultSaves[0]?.baseUpdatedAt, null)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_new' }])
  assert.deepEqual(calls.details, ['vlt_new'])
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('New vault on the home vaults tab opens the creation form', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }) })
  assert.equal(view.find({ role: 'button', text: 'New vault' }), null)
  await view.press({ role: 'button', text: 'Vaults' })
  await view.press({ role: 'button', text: 'New vault' })
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'newConfig', kind: 'vault' }])
  assert.ok(view.find({ text: 'New vault' }))
  assert.ok(view.find({ label: 'Name' }))
  await view.unmount()
})

test('Archive and Delete ask first, then act on the vault and return home with the list reread', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_VAULT })
  await view.press({ role: 'button', text: 'Archive' })
  assert.ok(view.find({ type: 'Callout', text: /Archive GitHub\? This can't be undone\./ }))
  assert.deepEqual(calls.archives, [])
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Archive' })
  assert.deepEqual(calls.archives, [{ kind: 'vault', id: 'vlt_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.ok(calls.lists.length > listsBefore)
  await view.unmount()

  const second = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_VAULT })
  await second.press({ role: 'button', text: 'Delete' })
  assert.ok(second.find({ type: 'Callout', text: /Delete GitHub for good\? This can't be undone\./ }))
  await second.press({ role: 'button', text: 'Delete' })
  assert.deepEqual(calls.deletes, [{ kind: 'vault', id: 'vlt_a' }])
  assert.deepEqual(second.persisted.plugin.nav, [{ view: 'home' }])
  await second.unmount()
})

// --- Ouverture d'un identifiant ---

test('a credential row opens its form, and Add credential opens an empty one', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: OPEN_VAULT })
  await view.press({ type: 'ListItem', label: 'Deploy token' })
  assert.deepEqual(view.persisted.plugin.nav, [
    { view: 'home' },
    { view: 'config', kind: 'vault', id: 'vlt_a' },
    { view: 'credential', vaultId: 'vlt_a', credentialId: 'vcrd_env' }
  ])
  assert.equal(view.valueOf({ label: 'Name' }), 'Deploy token')
  await view.press({ role: 'button', text: /Back/ })
  assert.ok(view.find({ type: 'ListItem', label: 'Deploy token' }))
  await view.press({ role: 'button', text: 'Add credential' })
  assert.deepEqual(view.persisted.plugin.nav.at(-1), { view: 'credential', vaultId: 'vlt_a', credentialId: null })
  assert.equal(view.valueOf({ label: 'Name' }), '')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a credential form reopened after a restart loads its vault again', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_bearer') })
  assert.deepEqual(calls.details, ['vlt_a'])
  assert.equal(view.valueOf({ label: 'Name' }), 'GitHub bearer')
  await view.unmount()
})

test('offers the credential types with the exact labels, the OAuth one disabled', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: openCredential(null) })
  const select = view.find({ type: 'Select', label: 'Type' })
  assert.ok(select)
  const options = select.props.options as { value: string; label: string; disabled?: boolean }[]
  assert.deepEqual(
    options.map((option) => [option.label, option.disabled === true]),
    [
      ['Bearer token', false],
      ['Environment variable', false],
      ['MCP OAuth (later version)', true]
    ]
  )
  await view.unmount()
})

// --- Secrets ---

test('creating a bearer credential asks for a Token, sends it once and never persists it', async () => {
  const calls = newCalls()
  const during: { persisted?: string; disabled?: boolean } = {}
  let view: View | undefined
  const host = mockHost({
    requests: requests(calls, {
      'credential.save': async (input: CredentialSave) => {
        calls.credentialSaves.push(input)
        // Le temps de laisser le panneau se redessiner avec l'enregistrement en cours.
        await new Promise((resolve) => setTimeout(resolve, 20))
        during.persisted = view ? persistedText(view) : undefined
        during.disabled = view?.find({ label: 'Token' })?.disabled
        return { ok: true, value: { id: 'vcrd_new', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  view = await mount(panel, { host, persisted: openCredential(null) })
  assert.equal(view.find({ label: 'Token' })?.props.type, 'password')
  assert.equal(view.find({ label: 'Replace token' }), null)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.type({ label: 'MCP server URL' }, 'https://example.com/mcp')
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.type({ label: 'Token' }, TOKEN)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, false)
  // Avant l'envoi : le jeton vit en mémoire, jamais dans ce qui est persisté.
  assert.equal(persistedText(view).includes(TOKEN), false)
  assert.equal(Object.values(read(secretDrafts)).includes(TOKEN), true)
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.credentialSaves.length, 1)
  const sent = calls.credentialSaves[0]
  assert.ok(sent)
  assert.equal(sent.vaultId, 'vlt_a')
  assert.equal(sent.id, null)
  assert.equal(sent.base, null)
  assert.equal(sent.baseUpdatedAt, null)
  assert.equal(sent.force, false)
  assert.deepEqual(sent.form, { type: 'static_bearer', name: '', mcpServerUrl: 'https://example.com/mcp', token: TOKEN })
  // Pendant l'envoi : champs verrouillés, jeton toujours absent du persisté.
  assert.equal(during.persisted?.includes(TOKEN), false)
  assert.equal(during.disabled, true)
  // Après : le secret est oublié, le panneau revient au coffre relu.
  assert.equal(persistedText(view).includes(TOKEN), false)
  assert.deepEqual(read(secretDrafts), {})
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }])
  assert.deepEqual(calls.details, ['vlt_a', 'vlt_a'])
  assert.ok(calls.lists.includes('vault'))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('editing a bearer credential shows the URL as text, keeps the token on empty and replaces it when typed', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_bearer') })
  // L'URL est fixée à la création : du texte, pas un champ.
  assert.equal(view.find({ label: 'MCP server URL' }), null)
  assert.ok(view.find({ text: /https:\/\/api\.githubcopilot\.com\/mcp\// }))
  assert.equal(view.find({ label: 'Token' }), null)
  assert.equal(view.find({ type: 'Select', label: 'Type' }), null)
  const field = view.find({ type: 'Field', text: /Leave empty to keep the current one\./ })
  assert.ok(field)
  assert.equal(field.props.description, 'Leave empty to keep the current one.')
  assert.equal(view.find({ label: 'Replace token' })?.props.type, 'password')
  assert.equal(view.valueOf({ label: 'Replace token' }), '')
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  await view.type({ label: 'Name' }, 'Renamed', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.credentialSaves.length, 1)
  const renamed = calls.credentialSaves[0]
  assert.ok(renamed)
  assert.equal(renamed.id, 'vcrd_bearer')
  assert.equal(renamed.vaultId, 'vlt_a')
  assert.equal(renamed.baseUpdatedAt, BEARER_ROW.updatedAt)
  assert.deepEqual(renamed.base, BEARER_FORM)
  assert.deepEqual(renamed.form, { ...BEARER_FORM, name: 'Renamed' })
  // Un secret tapé seul suffit à enregistrer, puis le champ se vide.
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  await view.type({ label: 'Replace token' }, TOKEN)
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, false)
  assert.ok(view.find({ text: 'Unsaved changes' }))
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.credentialSaves.length, 2)
  assert.deepEqual(calls.credentialSaves[1]?.form, { ...BEARER_FORM, token: TOKEN })
  assert.equal(view.valueOf({ label: 'Replace token' }), '')
  assert.deepEqual(read(secretDrafts), {})
  assert.equal(persistedText(view).includes(TOKEN), false)
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('an environment credential: creation fields, then read-only variable name and Replace value on edit', async () => {
  const calls = newCalls()
  const created = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential(null) })
  await created.select({ label: 'Type' }, 'environment_variable')
  assert.equal(created.find({ label: 'Value' })?.props.type, 'password')
  assert.equal(created.find({ label: 'MCP server URL' }), null)
  await created.type({ label: 'Name' }, 'plugin-test-var')
  await created.type({ label: 'Variable name' }, 'PLUGIN_TEST_VAR')
  await created.type({ label: 'Value' }, TOKEN)
  await created.select({ label: 'Network' }, 'limited')
  await created.type({ label: 'Allowed hosts' }, 'example.com\napi.example.com')
  await created.toggle({ label: 'Inject in body' })
  await created.press({ role: 'button', text: 'Create' })
  assert.equal(calls.credentialSaves.length, 1)
  assert.deepEqual(calls.credentialSaves[0]?.form, {
    type: 'environment_variable',
    name: 'plugin-test-var',
    secretName: 'PLUGIN_TEST_VAR',
    secretValue: TOKEN,
    network: { mode: 'limited', allowedHosts: ['example.com', 'api.example.com'] },
    injection: { header: true, body: true }
  })
  assert.equal(persistedText(created).includes(TOKEN), false)
  await created.unmount()

  const edited = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_env') })
  assert.equal(edited.find({ label: 'Variable name' }), null)
  assert.ok(edited.find({ text: /DEPLOY_TOKEN/ }))
  assert.equal(edited.find({ label: 'Value' }), null)
  assert.equal(edited.find({ label: 'Replace value' })?.props.type, 'password')
  assert.ok(edited.find({ type: 'Field', text: /Leave empty to keep the current one\./ }))
  assert.equal(edited.valueOf({ label: 'Allowed hosts' }), 'example.com')
  await edited.toggle({ label: 'Inject in body' })
  await edited.press({ role: 'button', text: 'Save' })
  assert.equal(calls.credentialSaves.length, 2)
  const sent = calls.credentialSaves[1]
  assert.equal(sent?.id, 'vcrd_env')
  assert.deepEqual(sent?.base, ENV_FORM)
  assert.deepEqual(sent?.form, { ...ENV_FORM, injection: { header: true, body: true } })
  await edited.unmount()
})

test('an environment credential with no injection place is flagged before any send and keeps Save disabled', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_env') })
  await view.toggle({ label: 'Inject in header' })
  assert.ok(view.find({ text: 'Inject the value in a header, the body, or both.' }))
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  assert.equal(calls.credentialSaves.length, 0)
  await view.toggle({ label: 'Inject in body' })
  assert.equal(view.find({ text: 'Inject the value in a header, the body, or both.' }), null)
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, false)
  await view.unmount()
})

test('a credential form typed then restarted comes back with Unsaved changes and the secret cleared, never with the token', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_bearer') })
  await first.type({ label: 'Name' }, 'Kept name', { replace: true })
  await first.type({ label: 'Replace token' }, TOKEN)
  assert.equal(first.find({ text: 'Secret fields were cleared.' }), null)
  const persisted = { plugin: first.persisted.plugin }
  assert.equal(JSON.stringify(persisted).includes(TOKEN), false)
  await first.unmount()

  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.equal(view.valueOf({ label: 'Name' }), 'Kept name')
  assert.ok(view.find({ text: 'Unsaved changes' }))
  assert.ok(view.find({ text: 'Secret fields were cleared.' }))
  assert.equal(view.valueOf({ label: 'Replace token' }), '')
  assert.equal(persistedText(view).includes(TOKEN), false)
  // Retaper un secret lève l'avis ; Discard oublie tout.
  await view.type({ label: 'Replace token' }, TOKEN)
  assert.equal(view.find({ text: 'Secret fields were cleared.' }), null)
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(view.valueOf({ label: 'Name' }), 'GitHub bearer')
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.equal(view.find({ text: 'Secret fields were cleared.' }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a secret typed alone on a new credential also comes back cleared after a restart', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential(null) })
  await first.type({ label: 'Token' }, TOKEN)
  const persisted = { plugin: first.persisted.plugin }
  assert.equal(JSON.stringify(persisted).includes(TOKEN), false)
  await first.unmount()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.ok(view.find({ text: 'Secret fields were cleared.' }))
  assert.equal(view.valueOf({ label: 'Token' }), '')
  await view.unmount()
})

test('two vaults keep separate new-credential drafts', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential(null) })
  await first.type({ label: 'Name' }, 'For vault A')
  const persisted = first.persisted.plugin
  await first.unmount()
  const other = {
    plugin: { ...persisted, nav: [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_b' }, { view: 'credential', vaultId: 'vlt_b', credentialId: null }] }
  }
  const view = await mount(panel, {
    host: mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: { ...VAULT, id: 'vlt_b' } } }) }),
    persisted: other
  })
  assert.equal(view.valueOf({ label: 'Name' }), '')
  await view.unmount()
})

test('a refused credential save shows the reason and keeps the input, the secret included', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'credential.save': { ok: false, code: 'invalid', error: 'The token was refused.' } }) })
  const view = await mount(panel, { host, persisted: openCredential('vcrd_bearer') })
  await view.type({ label: 'Replace token' }, TOKEN)
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /The token was refused\./ }))
  assert.equal(view.valueOf({ label: 'Replace token' }), TOKEN)
  assert.equal(persistedText(view).includes(TOKEN), false)
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, false)
  await view.unmount()
})

test('a credential conflict offers Save anyway, which forces the write with the draft base', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, {
      'credential.save': (input: CredentialSave) => {
        calls.credentialSaves.push(input)
        answers += 1
        return answers === 1 ? CONFLICT : { ok: true, value: { id: 'vcrd_bearer', updatedAt: '2026-11-22T12:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: openCredential('vcrd_bearer') })
  await view.type({ label: 'Replace token' }, TOKEN)
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(calls.credentialSaves.length, 2)
  assert.equal(calls.credentialSaves[1]?.force, true)
  assert.equal(calls.credentialSaves[1]?.baseUpdatedAt, BEARER_ROW.updatedAt)
  assert.deepEqual(calls.credentialSaves[1]?.form, { ...BEARER_FORM, token: TOKEN })
  assert.deepEqual(read(secretDrafts), {})
  await view.unmount()
})

test('a credential draft kept on an older version shows the conflict and sends its own base', async () => {
  const calls = newCalls()
  const persisted = {
    plugin: {
      ...openCredential('vcrd_bearer').plugin,
      'forms.drafts': {
        'credential:vcrd_bearer': { form: { ...BEARER_FORM, name: 'Mine' }, base: { ...BEARER_FORM, name: 'Older name' }, baseStamp: T0 }
      }
    }
  }
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.credentialSaves[0]?.baseUpdatedAt, T0)
  assert.deepEqual(calls.credentialSaves[0]?.base, { ...BEARER_FORM, name: 'Older name' })
  await view.unmount()
})

// --- Libellés longs, OAuth, actions ---

test('a credential name of 2000 bytes is clipped under 1 KiB in the list and in the form', async () => {
  const long = '😀'.repeat(500)
  assert.equal(byteLength(long), 2000)
  const vault: VaultDetail = { ...VAULT, credentials: [{ ...BEARER_ROW, name: long, form: { ...BEARER_FORM, name: long } }] }
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: vault } }) })
  const list = await mount(panel, { host, persisted: OPEN_VAULT })
  const row = list.find({ type: 'ListItem' })
  assert.ok(row)
  assert.ok(byteLength(row.label ?? '') < 1024)
  assert.ok((row.label ?? '').length > 0)
  assert.deepEqual(list.errors, [])
  await list.unmount()

  const form = await mount(panel, { host: mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: vault } }) }), persisted: openCredential('vcrd_bearer') })
  assert.deepEqual(form.errors, [])
  for (const text of form.findAll({ type: 'Text' })) assert.ok(byteLength(text.text) < 1024)
  await form.press({ role: 'button', text: 'Archive' })
  const question = form.find({ type: 'Callout', text: /Archive .*\? This can't be undone\./ })
  assert.ok(question)
  assert.ok(byteLength(question.text) < 1024)
  await form.unmount()
})

test('an OAuth credential is read-only with Archive and Delete, and no form', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_oauth') })
  assert.ok(view.find({ text: /GitHub OAuth/ }))
  assert.ok(view.find({ text: /MCP OAuth/ }))
  assert.equal(view.findAll({ type: 'Input' }).length, 0)
  assert.equal(view.find({ type: 'Select' }), null)
  assert.equal(view.find({ role: 'button', text: 'Save' }), null)
  assert.ok(view.find({ role: 'button', text: 'Archive' }))
  assert.ok(view.find({ role: 'button', text: 'Delete' }))
  await view.press({ role: 'button', text: 'Archive' })
  assert.deepEqual(calls.archives, [])
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Archive' })
  assert.deepEqual(calls.archives, [{ kind: 'credential', vaultId: 'vlt_a', id: 'vcrd_oauth' }])
  // De retour sur le coffre relu, la liste des coffres aussi.
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }])
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['vlt_a', 'vlt_a'])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Delete on an editable credential asks first, then deletes it and returns to the vault', async () => {
  const calls = newCalls()
  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: openCredential('vcrd_env') })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete Deploy token for good\? This can't be undone\./ }))
  assert.deepEqual(calls.deletes, [])
  await view.press({ role: 'button', text: 'Delete' })
  assert.deepEqual(calls.deletes, [{ kind: 'credential', vaultId: 'vlt_a', id: 'vcrd_env' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }])
  await view.unmount()
})

test('an archive refused by the API shows its text and keeps the credential form open', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'resource.archive': { ok: false, code: 'other', error: 'Credential is in use.' } }) })
  const view = await mount(panel, { host, persisted: openCredential('vcrd_bearer') })
  await view.press({ role: 'button', text: 'Archive' })
  await view.press({ role: 'button', text: 'Archive' })
  assert.equal(read(notice), 'Credential is in use.')
  assert.deepEqual(view.persisted.plugin.nav, openCredential('vcrd_bearer').plugin.nav)
  await view.unmount()
})

test('a credential archived elsewhere says so instead of showing a form', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: openCredential('vcrd_gone') })
  assert.ok(view.find({ text: /no longer exists/ }))
  assert.equal(view.findAll({ type: 'Input' }).length, 0)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

// --- Erreurs : pas de rouge à l'ouverture ---

test('the vault Name shows no error on open, and shows it after typing then clearing', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: OPEN_NEW_VAULT })
  assert.equal(invalidOf(view, 'Name'), false)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.type({ label: 'Name' }, 'a')
  assert.equal(invalidOf(view, 'Name'), false)
  await view.type({ label: 'Name' }, '', { replace: true })
  assert.equal(invalidOf(view, 'Name'), true)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.unmount()
})

test('the environment Name shows no error on open, and shows it after typing then clearing', async () => {
  const persisted = { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'environment' }] } }
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted })
  assert.equal(invalidOf(view, 'Name'), false)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.type({ label: 'Name' }, 'a')
  await view.type({ label: 'Name' }, '', { replace: true })
  assert.equal(invalidOf(view, 'Name'), true)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.unmount()
})

test('a new credential shows no required-field error on open, and shows it after typing then clearing', async () => {
  const view = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: openCredential(null) })
  assert.equal(invalidOf(view, 'MCP server URL'), false)
  assert.equal(invalidOf(view, 'Token'), false)
  assert.equal(view.find({ text: 'Enter the MCP server URL.' }), null)
  assert.equal(view.find({ text: 'Enter the token.' }), null)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.type({ label: 'MCP server URL' }, 'h')
  await view.type({ label: 'MCP server URL' }, '', { replace: true })
  assert.equal(invalidOf(view, 'MCP server URL'), true)
  assert.ok(view.find({ text: 'Enter the MCP server URL.' }))
  // Le jeton, intact, reste sans erreur.
  assert.equal(invalidOf(view, 'Token'), false)
  await view.type({ label: 'MCP server URL' }, 'https://example.com/mcp')
  assert.equal(view.find({ text: 'Enter the MCP server URL.' }), null)
  assert.equal(view.find({ text: 'Enter the token.' }), null)
  await view.type({ label: 'Token' }, 'x')
  await view.type({ label: 'Token' }, '', { replace: true })
  assert.equal(invalidOf(view, 'Token'), true)
  assert.ok(view.find({ text: 'Enter the token.' }))
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.unmount()
})

test('the fields of a credential are disabled while its save is in flight', async () => {
  const calls = newCalls()
  const seen: Record<string, boolean | undefined> = {}
  let view: View | undefined
  const host = mockHost({
    requests: requests(calls, {
      'credential.save': async (input: CredentialSave) => {
        calls.credentialSaves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        seen.name = view?.find({ label: 'Name' })?.disabled
        seen.token = view?.find({ label: 'Replace token' })?.disabled
        return { ok: true, value: { id: 'vcrd_bearer', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  view = await mount(panel, { host, persisted: openCredential('vcrd_bearer') })
  await view.type({ label: 'Replace token' }, TOKEN)
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(seen, { name: true, token: true })
  assert.equal(view.find({ label: 'Name' })?.disabled, false)
  await view.unmount()
})

// --- Retour en arrière pendant un appel ---

/** Un `await` plus tard, la personne a appuyé sur Back : l'écran d'origine n'est plus au sommet de la pile. */
const backWhileSaving = (): void => update(nav, popView)

test('creating a credential then pressing Back before the answer leaves the vault on top, not home', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'credential.save': async (input: CredentialSave) => {
        calls.credentialSaves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        backWhileSaving()
        return { ok: true, value: { id: 'vcrd_new', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: openCredential(null) })
  await view.type({ label: 'MCP server URL' }, 'https://example.com/mcp')
  await view.type({ label: 'Token' }, TOKEN)
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.credentialSaves.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('deleting a credential then pressing Back before the answer leaves the vault on top, not home', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'resource.delete': async (input: unknown) => {
        calls.deletes.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        backWhileSaving()
        return { ok: true, value: null }
      }
    })
  })
  const view = await mount(panel, { host, persisted: openCredential('vcrd_env') })
  await view.press({ role: 'button', text: 'Delete' })
  await view.press({ role: 'button', text: 'Delete' })
  assert.equal(calls.deletes.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'vault', id: 'vlt_a' }])
  await view.unmount()
})

test('creating a vault then pressing Back before the answer stays on home and does not open the new vault', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'vault.save': async (input: SaveInput<VaultForm>) => {
        calls.vaultSaves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        backWhileSaving()
        return { ok: true, value: { id: 'vlt_new', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW_VAULT })
  await view.type({ label: 'Name' }, 'plugin-test-vault')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.vaultSaves.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  await view.unmount()
})
