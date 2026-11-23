import { assert, mockHost, mount, test } from 'orca/testing'
import type { WorkspaceInfo, WorkspaceRow } from '../protocol'
import * as panel from '../panel'

const DEFAULT_ROW: WorkspaceRow = { localId: 'ws_1', name: 'Default', workspaceId: 'wrkspc_default', active: true }
const OTHER_ROW: WorkspaceRow = { localId: 'ws_2', name: 'Orca-claude', workspaceId: 'wrkspc_orca', active: false }

/** L'identité d'un panneau avec ces deux workspaces ; `activeLocalId` dit lequel est actif. */
function info(activeLocalId: string | null, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  const rows = [DEFAULT_ROW, OTHER_ROW].map((row) => ({ ...row, active: row.localId === activeLocalId }))
  const active = rows.find((row) => row.active)
  return {
    hasKey: active !== undefined,
    keyRejected: false,
    workspaceId: active?.workspaceId ?? null,
    organizationName: 'Check Org',
    workspaces: rows,
    ...over
  }
}

const NO_WORKSPACE: WorkspaceInfo = { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null, workspaces: [] }

const TYPED_KEY = 'plugin-test-token-QUOKKA-typed'

/** Les lectures communes de l'accueil ; `over` remplace ou complète. */
function requests(start: WorkspaceInfo, over: Record<string, unknown> = {}) {
  return {
    'workspace.info': start,
    'sessions.visibility': { bootId: 'boot-1', watching: null },
    'sessions.list': { ok: true, value: [] },
    'configs.list': { ok: true, value: [] },
    ...over
  } as never
}

test('lists the workspaces with the Active badge and no fold', async () => {
  const host = mockHost({ requests: requests(info('ws_1')) })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Workspaces' }))
  assert.ok(view.find({ text: 'Default' }))
  assert.ok(view.find({ text: 'wrkspc_default' }))
  assert.ok(view.find({ text: 'Orca-claude' }))
  assert.ok(view.find({ text: 'wrkspc_orca' }))
  const badges = view.findAll({ type: 'Badge', text: 'Active' })
  assert.equal(badges.length, 1)
  // Le ✓ n'existe que sur le workspace inactif ; le ✎ est sur les deux.
  assert.equal(view.findAll({ type: 'IconButton', label: 'Use this workspace' }).length, 1)
  assert.ok(view.find({ type: 'IconButton', label: 'Edit Default' }))
  assert.ok(view.find({ type: 'IconButton', label: 'Edit Orca-claude' }))
  assert.deepEqual(view.findAll({ type: 'Collapsible' }), [])
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('says Workspace unknown for an entry whose id could not be read', async () => {
  const start = info('ws_1')
  const host = mockHost({
    requests: requests({ ...start, workspaces: start.workspaces.map((row) => (row.localId === 'ws_2' ? { ...row, workspaceId: null } : row)) })
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Workspace unknown' }))
  await view.unmount()
})

test('clips a workspace id of 2000 characters instead of letting Orca refuse the render', async () => {
  const longId = `wrkspc_${'Q'.repeat(1993)}`
  const start = info('ws_1')
  const host = mockHost({
    requests: requests({ ...start, workspaces: start.workspaces.map((row) => (row.localId === 'ws_2' ? { ...row, workspaceId: longId } : row)) })
  })
  const view = await mount(panel, { host })
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  // L'identifiant est coupé à 200 octets et la ligne reste affichée.
  assert.ok(view.find({ text: longId.slice(0, 200) }))
  assert.equal(view.find({ text: longId }), null)
  assert.ok(view.find({ text: 'Orca-claude' }))
  await view.unmount()
})

test('Use this workspace switches and goes back home', async () => {
  const activated: unknown[] = []
  let sessionReads = 0
  const host = mockHost({
    requests: requests(info('ws_1', { hasKey: true, keyRejected: true }), {
      'sessions.list': () => {
        sessionReads += 1
        return { ok: true, value: [] }
      },
      'workspaces.activate': (input: unknown) => {
        activated.push(input)
        return { ok: true, value: info('ws_2') }
      }
    })
  })
  const view = await mount(panel, {
    host,
    persisted: {
      plugin: {
        nav: [{ view: 'home' }, { view: 'config', kind: 'agent', id: 'agent_a' }],
        'home.filters': { agent: 'old filter', sessions: 'old session filter' },
        'home.tab': 'agent',
        // Une saisie gardée d'un formulaire de l'ancien workspace.
        'forms.drafts': { 'environment:env_a': { form: { name: 'typed' }, base: { name: 'old' }, baseStamp: null } }
      }
    }
  })
  const before = sessionReads
  assert.deepEqual(Object.keys(view.persisted.plugin['forms.drafts'] as object), ['environment:env_a'])
  await view.press({ type: 'IconButton', label: 'Use this workspace' })
  assert.deepEqual(activated, [{ localId: 'ws_2' }])
  // Les saisies gardées visaient des objets de l'ancien workspace : elles sont oubliées.
  assert.deepEqual(view.persisted.plugin['forms.drafts'], {})
  assert.deepEqual(view.persisted.plugin.nav, [{ view: 'home' }])
  assert.deepEqual(view.persisted.plugin['home.filters'], {})
  // L'onglet courant est gardé, et ses listes relues pour le nouveau workspace.
  assert.equal(view.persisted.plugin['home.tab'], 'agent')
  assert.ok(sessionReads > before)
  const badge = view.find({ type: 'Badge', text: 'Active' })
  assert.ok(badge)
  assert.ok(view.find({ type: 'IconButton', label: 'New agent' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('switching rereads the sessions of the new workspace', async () => {
  let sessionReads = 0
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'sessions.list': () => {
        sessionReads += 1
        return { ok: true, value: [] }
      },
      'workspaces.activate': () => ({ ok: true, value: info('ws_2') })
    })
  })
  const view = await mount(panel, { host })
  const before = sessionReads
  await view.press({ type: 'IconButton', label: 'Use this workspace' })
  assert.ok(sessionReads > before)
  await view.unmount()
})

test('a refused switch keeps the panel as it was and says why', async () => {
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.activate': { ok: false, code: 'not_found', error: 'This workspace is not in the list.' }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'home.filters': { sessions: 'keep me' } } } })
  await view.press({ type: 'IconButton', label: 'Use this workspace' })
  assert.ok(view.find({ type: 'Callout', text: /This workspace is not in the list\./ }))
  assert.deepEqual(view.persisted.plugin['home.filters'], { sessions: 'keep me' })
  await view.unmount()
})

test('Add shows the inline form and keeps the active one', async () => {
  const added: unknown[] = []
  let sessionReads = 0
  const third: WorkspaceRow = { localId: 'ws_3', name: 'Third', workspaceId: 'wrkspc_third', active: false }
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'sessions.list': () => {
        sessionReads += 1
        return { ok: true, value: [] }
      },
      'workspaces.add': (input: unknown) => {
        added.push(input)
        return added.length === 1
          ? { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
          : { ok: true, value: { ...info('ws_1'), workspaces: [...info('ws_1').workspaces, third] } }
      }
    })
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'API key' }), null)
  await view.press({ type: 'IconButton', label: 'Add workspace' })
  assert.ok(view.find({ label: 'Name' }))
  assert.ok(view.find({ label: 'API key' }))
  // Add reste grisé tant qu'un champ est vide.
  assert.equal(view.find({ role: 'button', text: 'Add' })?.props.disabled, true)
  await view.type({ label: 'Name' }, 'Third')
  assert.equal(view.find({ role: 'button', text: 'Add' })?.props.disabled, true)
  await view.type({ label: 'API key' }, TYPED_KEY)
  assert.notEqual(view.find({ role: 'button', text: 'Add' })?.props.disabled, true)
  assert.equal(view.find({ role: 'button', text: 'Add' })?.props.variant, 'solid')
  // Un refus s'affiche dans le formulaire, la saisie est gardée.
  await view.press({ role: 'button', text: 'Add' })
  assert.deepEqual(added, [{ name: 'Third', key: TYPED_KEY }])
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Third')
  assert.equal(view.valueOf({ label: 'API key' }), TYPED_KEY)
  // La clé tapée ne quitte jamais l'état en mémoire.
  assert.ok(!JSON.stringify(view.persisted).includes(TYPED_KEY))
  const readsBeforeSuccess = sessionReads
  await view.press({ role: 'button', text: 'Add' })
  assert.ok(view.find({ text: 'Third' }))
  assert.equal(view.find({ label: 'API key' }), null)
  // L'actif n'a pas changé : rien n'est relu, l'accueil reste où il est.
  assert.equal(sessionReads, readsBeforeSuccess)
  assert.equal(view.findAll({ type: 'Badge', text: 'Active' }).length, 1)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('Cancel closes the add form without calling the worker', async () => {
  const added: unknown[] = []
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.add': (input: unknown) => {
        added.push(input)
        return { ok: true, value: info('ws_1') }
      }
    })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Add workspace' })
  await view.type({ label: 'Name' }, 'Half typed')
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(view.find({ label: 'Name' }), null)
  assert.deepEqual(added, [])
  // Rouvert, le formulaire est vide.
  await view.press({ type: 'IconButton', label: 'Add workspace' })
  assert.equal(view.valueOf({ label: 'Name' }), '')
  await view.unmount()
})

test('Edit opens Name, New API key, one Save, Console and Remove', async () => {
  const calls: { name: string; input: unknown }[] = []
  const renamedInfo = (): WorkspaceInfo => ({
    ...info('ws_1'),
    workspaces: info('ws_1').workspaces.map((row) => (row.localId === 'ws_2' ? { ...row, name: 'Renamed' } : row))
  })
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.rename': (input: unknown) => {
        calls.push({ name: 'rename', input })
        return { ok: true, value: renamedInfo() }
      },
      'workspaces.replaceKey': (input: unknown) => {
        calls.push({ name: 'replaceKey', input })
        return { ok: true, value: renamedInfo() }
      },
      'workspaces.remove': (input: unknown) => {
        calls.push({ name: 'remove', input })
        return { ok: true, value: info('ws_1') }
      }
    })
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ label: 'New API key' }), null)
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  assert.equal(view.valueOf({ label: 'Name' }), 'Orca-claude')
  assert.ok(view.find({ label: 'New API key' }))
  assert.ok(view.find({ text: 'Leave empty to keep the current key.' }))
  // Plus de bouton « Save key » ni de champ « Replace key » : un seul Save.
  assert.equal(view.find({ role: 'button', text: 'Save key' }), null)
  assert.equal(view.findAll({ role: 'button', text: 'Save' }).length, 1)
  const consoleButton = view.find({ role: 'button', text: 'Console' })
  assert.ok(consoleButton)
  assert.equal(consoleButton.props.icon, 'open-external')
  assert.equal(consoleButton.props.variant, 'outline')
  assert.equal(view.find({ type: 'Link', text: 'Console' }), null)
  const remove = view.find({ role: 'button', text: 'Remove' })
  assert.ok(remove)
  assert.equal(remove.props.variant, 'outline')
  assert.equal(remove.props.tone, 'danger')
  await view.press({ role: 'button', text: 'Console' })
  assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: 'https://platform.claude.com/workspaces/wrkspc_orca/agents' }])
  // Un seul ✎ ouvert à la fois.
  await view.press({ type: 'IconButton', label: 'Edit Default' })
  assert.equal(view.findAll({ label: 'New API key' }).length, 1)
  assert.equal(view.valueOf({ label: 'Name' }), 'Default')
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  // Save reste grisé tant que ni le nom ni la clé n'ont changé.
  assert.equal(view.find({ role: 'button', text: 'Save' })?.props.disabled, true)
  await view.type({ label: 'Name' }, 'Renamed', { replace: true })
  assert.notEqual(view.find({ role: 'button', text: 'Save' })?.props.disabled, true)
  assert.equal(view.find({ role: 'button', text: 'Save' })?.props.variant, 'solid')
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(calls, [{ name: 'rename', input: { localId: 'ws_2', name: 'Renamed' } }])
  // Le nom est pris en compte : Save est de nouveau grisé.
  assert.equal(view.find({ role: 'button', text: 'Save' })?.props.disabled, true)
  await view.type({ label: 'New API key' }, TYPED_KEY)
  assert.ok(!JSON.stringify(view.persisted).includes(TYPED_KEY))
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(calls[1], { name: 'replaceKey', input: { localId: 'ws_2', key: TYPED_KEY } })
  assert.equal(calls.length, 2)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('one Save sends the rename then the new key, in that order', async () => {
  const order: { name: string; input: unknown }[] = []
  const renamed: WorkspaceInfo = {
    ...info('ws_1'),
    workspaces: info('ws_1').workspaces.map((row) => (row.localId === 'ws_2' ? { ...row, name: 'Both' } : row))
  }
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.rename': (input: unknown) => {
        order.push({ name: 'rename', input })
        return { ok: true, value: renamed }
      },
      'workspaces.replaceKey': (input: unknown) => {
        order.push({ name: 'replaceKey', input })
        return { ok: true, value: renamed }
      }
    })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  await view.type({ label: 'Name' }, 'Both', { replace: true })
  await view.type({ label: 'New API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(order, [
    { name: 'rename', input: { localId: 'ws_2', name: 'Both' } },
    { name: 'replaceKey', input: { localId: 'ws_2', key: TYPED_KEY } }
  ])
  assert.ok(view.find({ text: 'Both' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('a refused new key shows its error, keeps the key typed and the renamed workspace', async () => {
  const renamed: WorkspaceInfo = {
    ...info('ws_1'),
    workspaces: info('ws_1').workspaces.map((row) => (row.localId === 'ws_2' ? { ...row, name: 'Kept name' } : row))
  }
  const sent: string[] = []
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.rename': () => {
        sent.push('rename')
        return { ok: true, value: renamed }
      },
      'workspaces.replaceKey': () => {
        sent.push('replaceKey')
        return { ok: false, code: 'invalid', error: 'This key is for wrkspc_zzz, not wrkspc_orca.' }
      }
    })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  await view.type({ label: 'Name' }, 'Kept name', { replace: true })
  await view.type({ label: 'New API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(sent, ['rename', 'replaceKey'])
  assert.ok(view.find({ type: 'Callout', text: /This key is for wrkspc_zzz, not wrkspc_orca\./ }))
  assert.equal(view.valueOf({ label: 'New API key' }), TYPED_KEY)
  // Le renommage accepté reste : la ligne porte le nouveau nom et le champ aussi.
  assert.equal(view.valueOf({ label: 'Name' }), 'Kept name')
  assert.ok(view.find({ text: 'Kept name' }))
  await view.unmount()
})

test('a refused rename shows its error, keeps the name typed and does not send the key', async () => {
  const sent: string[] = []
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.rename': () => {
        sent.push('rename')
        return { ok: false, code: 'invalid', error: 'Name is required.' }
      },
      'workspaces.replaceKey': () => {
        sent.push('replaceKey')
        return { ok: true, value: info('ws_1') }
      }
    })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  await view.type({ label: 'Name' }, 'x', { replace: true })
  await view.type({ label: 'New API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save' })
  assert.deepEqual(sent, ['rename'])
  assert.ok(view.find({ type: 'Callout', text: /Name is required\./ }))
  assert.equal(view.valueOf({ label: 'Name' }), 'x')
  assert.equal(view.valueOf({ label: 'New API key' }), TYPED_KEY)
  await view.unmount()
})

test('a rejected key opens the detail with the paste-a-new-key help, and Console only for a known workspace', async () => {
  const start = info('ws_1', { keyRejected: true })
  const host = mockHost({
    requests: requests({ ...start, workspaces: start.workspaces.map((row) => (row.localId === 'ws_1' ? { ...row, workspaceId: null } : row)) })
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Paste a new key for this workspace.' }))
  assert.equal(view.find({ text: 'Leave empty to keep the current key.' }), null)
  assert.equal(view.find({ role: 'button', text: 'Console' }), null)
  await view.unmount()
})


test('Remove asks for a confirmation, Cancel calls nothing, the confirmation removes', async () => {
  const removed: unknown[] = []
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.remove': (input: unknown) => {
        removed.push(input)
        return { ok: true, value: { ...info('ws_1'), workspaces: [DEFAULT_ROW] } }
      }
    })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Edit Orca-claude' })
  await view.press({ role: 'button', text: 'Remove' })
  assert.ok(view.find({ type: 'Callout', text: /Remove Orca-claude\? Its key is deleted from this Mac\./ }))
  await view.press({ role: 'button', text: 'Cancel' })
  assert.deepEqual(removed, [])
  assert.equal(view.find({ type: 'Callout', text: /Its key is deleted from this Mac/ }), null)
  await view.press({ role: 'button', text: 'Remove' })
  await view.press({ role: 'button', text: 'Remove' })
  assert.deepEqual(removed, [{ localId: 'ws_2' }])
  assert.equal(view.find({ text: 'Orca-claude' }), null)
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('removing the active workspace goes back home on the new active one', async () => {
  const host = mockHost({
    requests: requests(info('ws_1'), {
      'workspaces.remove': { ok: true, value: { ...info('ws_2'), workspaces: [{ ...OTHER_ROW, active: true }] } }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'home.filters': { sessions: 'old' } } } })
  await view.press({ type: 'IconButton', label: 'Edit Default' })
  await view.press({ role: 'button', text: 'Remove' })
  await view.press({ role: 'button', text: 'Remove' })
  assert.deepEqual(view.persisted.plugin['home.filters'], {})
  assert.equal(view.find({ text: 'Default' }), null)
  assert.ok(view.find({ type: 'Badge', text: 'Active' }))
  await view.unmount()
})

test('removing the last workspace brings the key form back', async () => {
  const host = mockHost({
    requests: requests({ ...info('ws_1'), workspaces: [DEFAULT_ROW] }, { 'workspaces.remove': { ok: true, value: NO_WORKSPACE } })
  })
  const view = await mount(panel, { host })
  await view.press({ type: 'IconButton', label: 'Edit Default' })
  await view.press({ role: 'button', text: 'Remove' })
  await view.press({ role: 'button', text: 'Remove' })
  assert.ok(view.find({ label: 'API key' }))
  assert.equal(view.valueOf({ label: 'Name' }), 'Default')
  assert.equal(view.find({ role: 'button', text: 'Agents' }), null)
  await view.unmount()
})

test('Key missing badge', async () => {
  const start = info('ws_1', { hasKey: false })
  const host = mockHost({ requests: requests(start) })
  const view = await mount(panel, { host })
  const badge = view.find({ type: 'Badge', text: 'Key missing' })
  assert.ok(badge)
  assert.equal(view.find({ role: 'button', text: 'Agents' }), null)
  assert.equal(view.find({ role: 'button', text: 'Sessions' }), null)
  // Le détail ✎ est déjà ouvert sur New API key, sans autre geste.
  assert.ok(view.find({ label: 'New API key' }))
  assert.equal(view.find({ role: 'button', text: 'Save' })?.props.variant, 'solid')
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('Key rejected badge on the active workspace, detail open on New API key', async () => {
  const host = mockHost({ requests: requests(info('ws_1', { keyRejected: true })) })
  const view = await mount(panel, { host })
  const badge = view.find({ type: 'Badge', text: 'Key rejected' })
  assert.ok(badge)
  assert.equal(badge.props.tone, 'danger')
  assert.equal(view.find({ type: 'Badge', text: 'Active' }), null)
  assert.equal(view.find({ role: 'button', text: 'Agents' }), null)
  assert.ok(view.find({ label: 'New API key' }))
  await view.unmount()
})

test('replacing the rejected key of the active workspace reads the lists again', async () => {
  let sessionReads = 0
  const host = mockHost({
    requests: requests(info('ws_1', { keyRejected: true }), {
      'sessions.list': () => {
        sessionReads += 1
        return { ok: true, value: [] }
      },
      'workspaces.replaceKey': { ok: true, value: info('ws_1') }
    })
  })
  const view = await mount(panel, { host })
  assert.equal(sessionReads, 0)
  await view.type({ label: 'New API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save' })
  assert.ok(sessionReads >= 1)
  assert.ok(view.find({ role: 'button', text: 'Agents' }))
  assert.ok(view.find({ type: 'Badge', text: 'Active' }))
  assert.equal(view.find({ label: 'New API key' }), null)
  await view.unmount()
})

test('without any workspace the key form asks for a name prefilled with Default', async () => {
  const added: unknown[] = []
  const host = mockHost({
    requests: requests(NO_WORKSPACE, {
      'workspaces.add': (input: unknown) => {
        added.push(input)
        return { ok: true, value: { ...info('ws_1'), workspaces: [DEFAULT_ROW] } }
      }
    })
  })
  const view = await mount(panel, { host })
  assert.equal(view.valueOf({ label: 'Name' }), 'Default')
  assert.ok(view.find({ label: 'API key' }))
  assert.equal(view.find({ role: 'button', text: 'Save key' })?.props.disabled, true)
  await view.type({ label: 'API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save key' })
  assert.deepEqual(added, [{ name: 'Default', key: TYPED_KEY }])
  assert.ok(view.find({ type: 'Badge', text: 'Active' }))
  assert.ok(view.find({ role: 'button', text: 'Agents' }))
  assert.ok(!JSON.stringify(view.persisted).includes(TYPED_KEY))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})

test('the first key form keeps its input when the API refuses the key', async () => {
  const host = mockHost({
    requests: requests(NO_WORKSPACE, {
      'workspaces.add': { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
    })
  })
  const view = await mount(panel, { host })
  await view.type({ label: 'API key' }, TYPED_KEY)
  await view.press({ role: 'button', text: 'Save key' })
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  assert.equal(view.valueOf({ label: 'API key' }), TYPED_KEY)
  assert.equal(view.valueOf({ label: 'Name' }), 'Default')
  await view.unmount()
})

/** Ce qu'il faut au formulaire de création d'agent et à son parcours « New agent from YAML » (brouillon, revue, Confirm). */
function draftRequests(start: WorkspaceInfo, stateAnswer: () => unknown, over: Record<string, unknown> = {}) {
  return requests(start, {
    'agent.formOptions': { ok: true, value: { models: ['claude-sonnet-5'] } },
    'drafts.status': { folder: '/Users/someone/.config/agent-claude-managed/managed-agents', ready: true },
    'draft.state': stateAnswer,
    'draft.open': {
      ok: true,
      value: {
        ref: { kind: 'agent', agentId: null },
        file: 'new-agent.yaml',
        unapplied: false,
        writtenAt: '2026-11-22T10:00:00Z',
        savedAt: '2026-11-22T10:00:00Z',
        returnTo: null
      }
    },
    'draft.prepare': {
      ok: true,
      value: { token: 'plugin-test-token-QUOKKA-xyz', changes: [{ path: 'name', before: null, after: 'x', lines: null }], totalChanges: 1, creates: true }
    },
    ...over
  })
}

test('a switch forgets the draft flows: the new agent form of the next workspace shows no stale review', async () => {
  let afterSwitch = false
  const host = mockHost({
    requests: draftRequests(
      info('ws_1'),
      () => {
        // Avant la bascule le brouillon existe ; après, la relecture échoue : seul l'oubli du panneau le fait disparaître.
        if (afterSwitch) throw new Error('draft.state unavailable')
        return {
          ok: true,
          value: { ref: { kind: 'agent', agentId: null }, file: 'new-agent.yaml', unapplied: true, writtenAt: '2026-11-22T10:00:00Z', savedAt: '2026-11-22T10:00:00Z', returnTo: null }
        }
      },
      {
        'workspaces.activate': () => {
          afterSwitch = true
          return { ok: true, value: info('ws_2') }
        }
      }
    )
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'home.tab': 'agent' } } })
  await view.press({ type: 'IconButton', label: 'New agent' })
  await view.press({ role: 'button', text: 'New agent from YAML' })
  await view.press({ role: 'button', text: 'Apply' })
  // Le parcours est à la revue : Confirm attend.
  assert.ok(view.find({ role: 'button', text: 'Confirm' }))
  // Retour à l'accueil : le parcours du brouillon survit au retour, c'est ce que la bascule doit effacer.
  await view.press({ role: 'button', text: /Back/ })
  await view.press({ type: 'IconButton', label: 'New agent' })
  assert.ok(view.find({ role: 'button', text: 'Confirm' }))
  await view.press({ role: 'button', text: /Back/ })
  await view.press({ type: 'IconButton', label: 'Use this workspace' })
  await view.press({ type: 'IconButton', label: 'New agent' })
  assert.equal(view.find({ role: 'button', text: 'Confirm' }), null)
  assert.equal(view.find({ role: 'button', text: 'Apply' }), null)
  assert.equal(view.find({ text: /Unapplied draft|Draft open in the editor/ }), null)
  assert.ok(view.find({ role: 'button', text: 'New agent from YAML' }))
  assert.deepEqual([view.errors, view.warnings, view.refusals], [[], [], []])
  await view.unmount()
})
