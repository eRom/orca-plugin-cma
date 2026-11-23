import { read, update } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import type { ConfigKind, ConfigRow, EnvironmentDetail, EnvironmentForm, SaveInput } from '../protocol'
import * as panel from '../panel'
import { formDrafts } from './form-state'
import { nav, notice, popView } from './state'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: 'Check Org',
  workspaces: [{ localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_x', active: true }]
}

const CONFLICT = { ok: false, code: 'conflict', error: 'Changed elsewhere since you opened it.' } as const

const NO_PACKAGES = { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] }

const FORM: EnvironmentForm = {
  name: 'Sandbox',
  description: 'Old description',
  hosting: 'cloud',
  network: { mode: 'unrestricted' },
  packages: NO_PACKAGES,
  metadata: [{ key: 'team', value: 'infra' }]
}

const DETAIL: EnvironmentDetail = {
  kind: 'environment',
  id: 'env_a',
  name: 'Sandbox',
  description: 'Old description',
  updatedAt: '2026-11-22T10:00:00Z',
  form: FORM,
  hosting: 'cloud',
  network: { mode: 'unrestricted' },
  packages: [],
  metadata: [{ key: 'team', value: 'infra' }]
}

const NEW_DETAIL: EnvironmentDetail = {
  ...DETAIL,
  id: 'env_new',
  name: 'plugin-test-env',
  form: { ...FORM, name: 'plugin-test-env' }
}

const ROWS: ConfigRow[] = [{ kind: 'environment', id: 'env_a', name: 'Sandbox', summary: 'cloud · unrestricted' }]

const OPEN_DETAIL = { plugin: { nav: [{ view: 'home' }, { view: 'config', kind: 'environment', id: 'env_a' }] } }
const OPEN_NEW = { plugin: { nav: [{ view: 'home' }, { view: 'newConfig', kind: 'environment' }] } }

/** Les appels reçus par le faux worker, dans l'ordre. */
type Calls = {
  saves: SaveInput<EnvironmentForm>[]
  lists: ConfigKind[]
  details: string[]
  archives: unknown[]
  deletes: unknown[]
}

/** Les demandes communes ; `over` remplace ou complète, `calls` garde ce que le panneau envoie. */
function requests(calls: Calls, over: Record<string, unknown> = {}) {
  return {
    'workspace.info': WITH_KEY,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': ({ kind }: { kind: ConfigKind }) => {
      calls.lists.push(kind)
      return { ok: true, value: kind === 'environment' ? ROWS : [] }
    },
    'configs.detail': ({ id }: { id: string }) => {
      calls.details.push(id)
      return { ok: true, value: id === 'env_new' ? NEW_DETAIL : DETAIL }
    },
    'environment.save': (input: SaveInput<EnvironmentForm>) => {
      calls.saves.push(input)
      return { ok: true, value: { id: input.id ?? 'env_new', updatedAt: '2026-11-22T11:00:00Z' } }
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

function newCalls(): Calls {
  return { saves: [], lists: [], details: [], archives: [], deletes: [] }
}

/** Presse le dernier bouton de ce texte : la question de confirmation s'ouvre après le bouton du geste. */
async function pressConfirm(view: Awaited<ReturnType<typeof mount>>, text: string): Promise<void> {
  const last = view.findAll({ role: 'button', text }).at(-1)
  assert.ok(last, `no ${text} button`)
  await view.press(last)
}

test('creates a limited environment with a host and a package, then opens its detail', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  const create = (): boolean => view.find({ role: 'button', text: 'Create' })?.disabled ?? false
  assert.equal(create(), true)
  await view.type({ label: 'Name' }, 'plugin-test-env')
  assert.equal(create(), false)
  await view.select({ label: 'Network' }, 'limited')
  await view.type({ label: 'Allowed hosts' }, 'example.com')
  await view.toggle({ label: 'Allow package managers' })
  await view.type({ label: 'Packages' }, 'pip requests')
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.saves.length, 1)
  const sent = calls.saves[0]
  assert.ok(sent)
  assert.equal(sent.id, null)
  assert.equal(sent.base, null)
  assert.equal(sent.baseUpdatedAt, null)
  assert.equal(sent.force, false)
  assert.equal(sent.form.name, 'plugin-test-env')
  assert.deepEqual(sent.form.network, { mode: 'limited', allowedHosts: ['example.com'], allowPackageManagers: true, allowMcpServers: false })
  assert.deepEqual(sent.form.packages.pip, ['requests'])
  // Le panneau revient au détail du nouvel identifiant ; la liste est relue.
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }, { view: 'config', kind: 'environment', id: 'env_new' }])
  assert.ok(view.find({ type: 'Text', text: 'env_new' }))
  assert.deepEqual(calls.details, ['env_new'])
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(read(formDrafts), {})
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('packages are one line per package: several managers go out sorted, and a line without a known manager blocks Create', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-env')
  await view.type({ label: 'Packages' }, 'pip requests==2.32 httpx\nnpm typescript')
  assert.equal(view.find({ text: /Package lines must look like/ }), null)
  await view.press({ role: 'button', text: 'Create' })
  assert.deepEqual(calls.saves[0]?.form.packages, { apt: [], cargo: [], gem: [], go: [], npm: ['typescript'], pip: ['requests==2.32', 'httpx'] })
  await view.unmount()

  const second = await mount(panel, { host: mockHost({ requests: requests(newCalls()) }), persisted: OPEN_NEW })
  await second.type({ label: 'Name' }, 'plugin-test-env')
  await second.type({ label: 'Packages' }, 'requests')
  assert.ok(second.find({ text: /Package lines must look like "pip requests"/ }))
  assert.equal(second.find({ role: 'button', text: 'Create' })?.disabled, true)
  await second.unmount()
})

test('flags a package without package managers before any send and keeps Create disabled', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-env')
  await view.select({ label: 'Network' }, 'limited')
  await view.type({ label: 'Packages' }, 'pip requests')
  const rule = "Package installs need 'Allow package managers' in a limited network."
  assert.ok(view.find({ text: rule }))
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  assert.equal(calls.saves.length, 0)
  // La case cochée lève l'avis et réactive le bouton.
  await view.toggle({ label: 'Allow package managers' })
  assert.equal(view.find({ text: rule }), null)
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, false)
  await view.unmount()
})

test('shows the hosting without letting it change and saves the edit against the loaded version', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  assert.equal(view.find({ type: 'RadioGroup', label: 'Hosting' }), null)
  assert.ok(view.find({ text: /Hosting/ }))
  assert.equal(view.valueOf({ label: 'Description' }), 'Old description')
  // Rien n'a changé : rien à enregistrer.
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  await view.type({ label: 'Description' }, 'New description', { replace: true })
  assert.ok(view.find({ text: 'Unsaved changes' }))
  const listsBefore = calls.lists.length
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.saves.length, 1)
  const sent = calls.saves[0]
  assert.ok(sent)
  assert.equal(sent.id, 'env_a')
  assert.equal(sent.baseUpdatedAt, DETAIL.updatedAt)
  assert.equal(sent.force, false)
  assert.deepEqual(sent.base, DETAIL.form)
  assert.equal(sent.form.description, 'New description')
  // La liste et le détail sont relus ; la saisie gardée disparaît.
  assert.ok(calls.lists.length > listsBefore)
  assert.deepEqual(calls.details, ['env_a', 'env_a'])
  assert.deepEqual(read(formDrafts), {})
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a conflict offers Reload and Save anyway, and Save anyway forces the write', async () => {
  const calls = newCalls()
  let answers = 0
  const host = mockHost({
    requests: requests(calls, {
      'environment.save': (input: SaveInput<EnvironmentForm>) => {
        calls.saves.push(input)
        answers += 1
        return answers === 1 ? CONFLICT : { ok: true, value: { id: 'env_a', updatedAt: '2026-11-22T12:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.ok(view.find({ role: 'button', text: 'Reload' }))
  // La saisie reste là, prête à repartir.
  assert.equal(view.valueOf({ label: 'Description' }), 'Mine')
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(calls.saves.length, 2)
  assert.equal(calls.saves[0]?.force, false)
  assert.equal(calls.saves[1]?.force, true)
  assert.equal(calls.saves[1]?.form.description, 'Mine')
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('Reload after a conflict rereads the detail and drops the kept input', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls, { 'environment.save': CONFLICT }) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(calls.details, ['env_a'])
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Reload' })
  assert.deepEqual(calls.details, ['env_a', 'env_a'])
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.equal(view.valueOf({ label: 'Description' }), 'Old description')
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a typed input survives a panel restart, with Unsaved changes and Discard', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  await first.type({ label: 'Description' }, 'Kept text', { replace: true })
  await first.type({ label: 'Metadata' }, '\nowner=romain')
  const persisted = { plugin: first.persisted.plugin }
  await first.unmount()

  const view = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted })
  assert.equal(view.valueOf({ label: 'Description' }), 'Kept text')
  assert.equal(view.valueOf({ label: 'Metadata' }), 'team=infra\nowner=romain')
  assert.ok(view.find({ text: 'Unsaved changes' }))
  await view.press({ role: 'button', text: 'Discard' })
  assert.equal(view.valueOf({ label: 'Description' }), 'Old description')
  assert.equal(view.valueOf({ label: 'Metadata' }), 'team=infra')
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a kept draft started on an older version shows the conflict and Save sends that older version', async () => {
  const calls = newCalls()
  const first = await mount(panel, { host: mockHost({ requests: requests(calls) }), persisted: OPEN_DETAIL })
  await first.type({ label: 'Description' }, 'Mine', { replace: true })
  // Le brouillon retient la version sur laquelle il a été commencé.
  const drafts = first.persisted.plugin['forms.drafts'] as Record<string, { baseStamp: string | null; base: unknown }>
  assert.equal(drafts['environment:env_a']?.baseStamp, DETAIL.updatedAt)
  assert.deepEqual(drafts['environment:env_a']?.base, FORM)
  assert.equal(first.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  const persisted = { plugin: first.persisted.plugin }
  await first.unmount()

  // Entre-temps l'environnement a changé ailleurs : le détail relu est plus récent.
  const newer: EnvironmentDetail = { ...DETAIL, updatedAt: '2026-11-22T15:00:00Z' }
  const sends = newCalls()
  const host = mockHost({
    requests: requests(sends, {
      'configs.detail': { ok: true, value: newer },
      // Comme le worker : refuse une version périmée sauf si l'écriture est forcée.
      'environment.save': (input: SaveInput<EnvironmentForm>) => {
        sends.saves.push(input)
        return input.force || input.baseUpdatedAt === newer.updatedAt
          ? { ok: true, value: { id: 'env_a', updatedAt: '2026-11-22T16:00:00Z' } }
          : CONFLICT
      }
    })
  })
  const view = await mount(panel, { host, persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  assert.ok(view.find({ role: 'button', text: 'Reload' }))
  assert.equal(view.valueOf({ label: 'Description' }), 'Mine')
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(sends.saves.length, 1)
  assert.equal(sends.saves[0]?.baseUpdatedAt, DETAIL.updatedAt)
  assert.equal(sends.saves[0]?.force, false)
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(sends.saves.length, 2)
  assert.equal(sends.saves[1]?.force, true)
  assert.equal(sends.saves[1]?.baseUpdatedAt, DETAIL.updatedAt)
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('Reload on a stale kept draft drops it and shows the fresh version', async () => {
  const calls = newCalls()
  const newer: EnvironmentDetail = { ...DETAIL, description: 'Changed in the console', updatedAt: '2026-11-22T15:00:00Z', form: { ...FORM, description: 'Changed in the console' } }
  const persisted = {
    plugin: {
      ...OPEN_DETAIL.plugin,
      'forms.drafts': { 'environment:env_a': { form: { ...FORM, description: 'Mine' }, base: FORM, baseStamp: DETAIL.updatedAt } }
    }
  }
  const host = mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: newer } }) })
  const view = await mount(panel, { host, persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Reload' })
  assert.equal(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }), null)
  assert.equal(view.valueOf({ label: 'Description' }), 'Changed in the console')
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('typing a metadata key without a value does not turn it into key= while editing', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Metadata' }, '\na')
  assert.equal(view.valueOf({ label: 'Metadata' }), 'team=infra\na')
  await view.type({ label: 'Metadata' }, '=1')
  assert.equal(view.valueOf({ label: 'Metadata' }), 'team=infra\na=1')
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(calls.saves[0]?.form.metadata, [
    { key: 'team', value: 'infra' },
    { key: 'a', value: '1' }
  ])
  await view.unmount()
})

test('a refused save shows the reason and keeps the input', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, { 'environment.save': { ok: false, code: 'invalid', error: 'At most 16 allowed hosts.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(view.find({ type: 'Callout', text: /At most 16 allowed hosts\./ }))
  assert.equal(view.valueOf({ label: 'Description' }), 'Mine')
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, false)
  await view.unmount()
})

test('hides the network and package fields of a self-hosted environment', async () => {
  const calls = newCalls()
  const selfHosted: EnvironmentDetail = { ...DETAIL, hosting: 'self_hosted', network: { mode: 'host_managed' }, form: { ...FORM, hosting: 'self_hosted' } }
  const host = mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: selfHosted } }) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  assert.equal(view.find({ type: 'RadioGroup', label: 'Network' }), null)
  assert.equal(view.find({ type: 'Textarea', label: 'Packages' }), null)
  assert.ok(view.find({ text: /managed by the host/ }))
  assert.ok(view.find({ label: 'Name' }))
  await view.unmount()
})

test('Archive asks first, then archives and returns home with the list reread', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: { plugin: { ...OPEN_DETAIL.plugin, 'home.tab': 'environment' } } })
  await view.press({ role: 'button', text: 'Archive' })
  assert.ok(view.find({ type: 'Callout', text: /Archive Sandbox\? This can't be undone\./ }))
  assert.deepEqual(calls.archives, [])
  const listsBefore = calls.lists.length
  await pressConfirm(view, 'Archive')
  assert.deepEqual(calls.archives, [{ kind: 'environment', id: 'env_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.ok(calls.lists.length > listsBefore)
  assert.ok(view.find({ label: 'Filter' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('Delete asks first, then deletes and returns home with the list reread', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.press({ role: 'button', text: 'Delete' })
  assert.ok(view.find({ type: 'Callout', text: /Delete Sandbox for good\? This can't be undone\./ }))
  assert.deepEqual(calls.deletes, [])
  const listsBefore = calls.lists.length
  await pressConfirm(view, 'Delete')
  assert.deepEqual(calls.deletes, [{ kind: 'environment', id: 'env_a' }])
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.ok(calls.lists.length > listsBefore)
  await view.unmount()
})

test('an archive refused by the API shows its text and changes nothing', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, { 'resource.archive': { ok: false, code: 'other', error: 'Environment is still in use.' } })
  })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  await view.press({ role: 'button', text: 'Archive' })
  await pressConfirm(view, 'Archive')
  assert.equal(read(notice), 'Environment is still in use.')
  assert.deepEqual(view.persisted.plugin.nav, OPEN_DETAIL.plugin.nav)
  assert.ok(view.find({ type: 'Callout', text: /Archive Sandbox\?/ }))
  await view.unmount()
})

test('Save anyway on a restored draft sends the base it started on, so only the touched field goes', async () => {
  const calls = newCalls()
  const touched: EnvironmentForm = { ...FORM, name: 'Renamed' }
  const persisted = {
    plugin: { ...OPEN_DETAIL.plugin, 'forms.drafts': { 'environment:env_a': { form: touched, base: FORM, baseStamp: DETAIL.updatedAt } } }
  }
  // La console a changé la description depuis : le détail frais est plus récent.
  const newer: EnvironmentDetail = {
    ...DETAIL,
    description: 'Changed in the console',
    updatedAt: '2026-11-22T15:00:00Z',
    form: { ...FORM, description: 'Changed in the console' }
  }
  const host = mockHost({
    requests: requests(calls, {
      'configs.detail': { ok: true, value: newer },
      'environment.save': (input: SaveInput<EnvironmentForm>) => {
        calls.saves.push(input)
        return input.force ? { ok: true, value: { id: 'env_a', updatedAt: '2026-11-22T16:00:00Z' } } : CONFLICT
      }
    })
  })
  const view = await mount(panel, { host, persisted })
  assert.ok(view.find({ type: 'Callout', text: /Changed elsewhere since you opened it\./ }))
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.saves.length, 1)
  assert.equal(calls.saves[0]?.baseUpdatedAt, DETAIL.updatedAt)
  assert.deepEqual(calls.saves[0]?.base, FORM)
  await view.press({ role: 'button', text: 'Save anyway' })
  assert.equal(calls.saves.length, 2)
  const forced = calls.saves[1]
  assert.ok(forced)
  assert.equal(forced.force, true)
  assert.equal(forced.baseUpdatedAt, DETAIL.updatedAt)
  assert.deepEqual(forced.base, FORM)
  // Seul le nom diffère de la base envoyée : la description de la console n'est pas écrasée.
  assert.equal(forced.form.name, 'Renamed')
  assert.equal(forced.form.description, FORM.description)
  assert.deepEqual({ ...forced.form, name: FORM.name }, forced.base)
  await view.unmount()
})

test('a restored draft brought back to its base does not show Unsaved changes against a changed fresh version', async () => {
  const calls = newCalls()
  const persisted = {
    plugin: { ...OPEN_DETAIL.plugin, 'forms.drafts': { 'environment:env_a': { form: FORM, base: FORM, baseStamp: DETAIL.updatedAt } } }
  }
  const newer: EnvironmentDetail = {
    ...DETAIL,
    description: 'Changed in the console',
    updatedAt: '2026-11-22T15:00:00Z',
    form: { ...FORM, description: 'Changed in the console' }
  }
  const host = mockHost({ requests: requests(calls, { 'configs.detail': { ok: true, value: newer } }) })
  const view = await mount(panel, { host, persisted })
  assert.equal(view.find({ text: 'Unsaved changes' }), null)
  await view.unmount()
})

test('a metadata line without = is flagged before any send and keeps Save disabled', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_DETAIL })
  const message = 'Metadata lines must look like key=value.'
  await view.type({ label: 'Metadata' }, '\na')
  // Le texte reste tel quel : `a` ne devient pas `a=`.
  assert.equal(view.valueOf({ label: 'Metadata' }), 'team=infra\na')
  assert.ok(view.find({ text: message }))
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  assert.equal(calls.saves.length, 0)
  await view.type({ label: 'Metadata' }, '=1')
  assert.equal(view.find({ text: message }), null)
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, false)
  // Une clé vide est refusée aussi.
  await view.type({ label: 'Metadata' }, '\n=orphan')
  assert.ok(view.find({ text: message }))
  assert.equal(view.find({ role: 'button', text: 'Save' })?.disabled, true)
  await view.unmount()
})

test('a metadata line without = keeps Create disabled on a new environment', async () => {
  const calls = newCalls()
  const host = mockHost({ requests: requests(calls) })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-env')
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, false)
  await view.type({ label: 'Metadata' }, 'foo')
  assert.ok(view.find({ text: 'Metadata lines must look like key=value.' }))
  assert.equal(view.find({ role: 'button', text: 'Create' })?.disabled, true)
  await view.unmount()
})

test('the fields are disabled while a save is in flight, so a keystroke cannot be lost to the reread', async () => {
  const calls = newCalls()
  const seen: Record<string, boolean | undefined> = {}
  let view: Awaited<ReturnType<typeof mount>> | undefined
  const host = mockHost({
    requests: requests(calls, {
      'environment.save': async (input: SaveInput<EnvironmentForm>) => {
        calls.saves.push(input)
        // Le temps de laisser le panneau se redessiner avec l'enregistrement en cours.
        await new Promise((resolve) => setTimeout(resolve, 20))
        seen.name = view?.find({ label: 'Name' })?.disabled
        seen.description = view?.find({ label: 'Description' })?.disabled
        seen.metadata = view?.find({ label: 'Metadata' })?.disabled
        seen.network = view?.find({ type: 'RadioGroup', label: 'Network' })?.disabled
        return { ok: true, value: { id: 'env_a', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  view = await mount(panel, { host, persisted: OPEN_DETAIL })
  assert.equal(view.find({ label: 'Description' })?.disabled, false)
  await view.type({ label: 'Description' }, 'Mine', { replace: true })
  await view.press({ role: 'button', text: 'Save' })
  assert.equal(calls.saves.length, 1)
  assert.deepEqual(seen, { name: true, description: true, metadata: true, network: true })
  assert.equal(view.find({ label: 'Description' })?.disabled, false)
  await view.unmount()
})

test('creating an environment then pressing Back before the answer stays on home and does not open the new one', async () => {
  const calls = newCalls()
  const host = mockHost({
    requests: requests(calls, {
      'environment.save': async (input: SaveInput<EnvironmentForm>) => {
        calls.saves.push(input)
        await new Promise((resolve) => setTimeout(resolve, 20))
        // Un `await` plus tard, la personne a appuyé sur Back : le formulaire n'est plus au sommet de la pile.
        update(nav, popView)
        return { ok: true, value: { id: 'env_new', updatedAt: '2026-11-22T11:00:00Z' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: OPEN_NEW })
  await view.type({ label: 'Name' }, 'plugin-test-env')
  await view.press({ role: 'button', text: 'Create' })
  assert.equal(calls.saves.length, 1)
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
