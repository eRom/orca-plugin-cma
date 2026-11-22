import { read, set } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import {
  clearForm,
  dropFieldText,
  editForm,
  editSecret,
  fieldText,
  formConflict,
  formDrafts,
  formKey,
  isTouched,
  readForm,
  secretCleared,
  secretDrafts,
  setFieldText,
  touchField
} from './form-state'

type EnvForm = { name: string; packages: { pip: string[] }; metadata: { key: string; value: string }[] }

const BASE: EnvForm = { name: 'Sandbox', packages: { pip: ['requests'] }, metadata: [{ key: 'team', value: 'infra' }] }
/** Une base plus récente : la console a changé le nom depuis. */
const FRESH: EnvForm = { ...BASE, name: 'Changed in the console' }
const T1 = '2026-11-22T10:00:00Z'
const T2 = '2026-11-22T11:00:00Z'

/** Un composant vide suffit : seuls les atomes sont sous test. */
function Probe() {
  return null
}

test('formKey names a draft by kind and id, with new for a creation', () => {
  assert.equal(formKey('environment', 'env_1'), 'environment:env_1')
  assert.equal(formKey('environment', null), 'environment:new')
})

test('an edited form reads back as dirty and clearing it makes it clean again', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  assert.deepEqual(readForm(key, BASE, T1), { form: BASE, base: BASE, baseStamp: T1, dirty: false, stale: false })
  const edited: EnvForm = { ...BASE, name: 'Sandbox 2' }
  editForm(key, edited, BASE, T1)
  assert.deepEqual(readForm(key, BASE, T1), { form: edited, base: BASE, baseStamp: T1, dirty: true, stale: false })
  clearForm(key)
  assert.deepEqual(readForm(key, BASE, T1), { form: BASE, base: BASE, baseStamp: T1, dirty: false, stale: false })
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a draft keeps the base and the stamp of its first edit and reads as stale against a newer version', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'First' }, BASE, T1)
  // Une saisie suivante, même passée avec une base et un stamp plus récents, garde ceux de la première.
  editForm(key, { ...BASE, name: 'Second' }, FRESH, T2)
  assert.deepEqual(readForm(key, BASE, T1), {
    form: { ...BASE, name: 'Second' },
    base: BASE,
    baseStamp: T1,
    dirty: true,
    stale: false
  })
  const reread = readForm(key, FRESH, T2)
  assert.equal(reread.baseStamp, T1)
  assert.deepEqual(reread.base, BASE)
  assert.equal(reread.stale, true)
  clearForm(key)
  editForm(key, { ...BASE, name: 'Third' }, FRESH, T2)
  assert.equal(readForm(key, FRESH, T2).baseStamp, T2)
  assert.deepEqual(readForm(key, FRESH, T2).base, FRESH)
  await view.unmount()
})

test('readForm gives the base of the draft, not the fresh one', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'Renamed' }, BASE, T1)
  const read1 = readForm(key, FRESH, T2)
  assert.deepEqual(read1.base, BASE)
  assert.equal(read1.baseStamp, T1)
  assert.equal(read1.stale, true)
  assert.equal(read1.dirty, true)
  await view.unmount()
})

test('a draft brought back to its own base is not dirty even against a different fresh base', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'Renamed' }, BASE, T1)
  editForm(key, structuredClone(BASE), FRESH, T2)
  const reread = readForm(key, FRESH, T2)
  assert.equal(reread.dirty, false)
  assert.deepEqual(reread.form, BASE)
  assert.equal(reread.stale, true)
  await view.unmount()
})

test('a creation draft has no base stamp and is never stale', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:new'
  editForm(key, { ...BASE, name: 'New one' }, BASE)
  assert.deepEqual(readForm(key, BASE), { form: { ...BASE, name: 'New one' }, base: BASE, baseStamp: null, dirty: true, stale: false })
  await view.unmount()
})

test('a numeric stamp is kept as is', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'agent:agent_1'
  editForm(key, { ...BASE, name: 'Mine' }, BASE, 3)
  assert.equal(readForm(key, BASE, 3).stale, false)
  assert.equal(readForm(key, BASE, 4).stale, true)
  assert.equal(readForm(key, BASE, 4).baseStamp, 3)
  await view.unmount()
})

test('a draft persisted without a base (the previous shape) is ignored', async () => {
  const previous: unknown = { form: { ...BASE, name: 'Previous shape' }, baseUpdatedAt: T1 }
  const old: unknown = { ...BASE, name: 'Old shape' }
  const view = await mount(Probe, {
    host: mockHost(),
    persisted: { plugin: { 'forms.drafts': { 'environment:env_1': previous, 'environment:env_2': old } } }
  })
  assert.deepEqual(readForm('environment:env_1', BASE, T1), { form: BASE, base: BASE, baseStamp: T1, dirty: false, stale: false })
  assert.deepEqual(readForm('environment:env_2', BASE, T1), { form: BASE, base: BASE, baseStamp: T1, dirty: false, stale: false })
  // Une première saisie la remplace par une saisie à la forme courante.
  editForm('environment:env_1', { ...BASE, name: 'Fresh' }, BASE, T1)
  assert.equal(readForm('environment:env_1', BASE, T1).dirty, true)
  await view.unmount()
})

test('a kept entry equal to the base in depth is not dirty', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, structuredClone(BASE), BASE, T1)
  assert.equal(readForm(key, BASE, T1).dirty, false)
  editForm(key, { ...structuredClone(BASE), packages: { pip: ['requests', 'numpy'] } }, BASE, T1)
  assert.equal(readForm(key, BASE).dirty, true)
  await view.unmount()
})

test('drafts persist for the plugin while secret drafts and conflicts never do', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'Sandbox 2' }, BASE, T1)
  set(secretDrafts, { [key]: 'plugin-test-token-QUOKKA-xyz' })
  set(formConflict, { [key]: true })
  await view.rerender()
  const persisted = view.persisted.plugin['forms.drafts'] as Record<string, unknown>
  assert.deepEqual(persisted[key], { form: { ...BASE, name: 'Sandbox 2' }, base: BASE, baseStamp: T1 })
  assert.equal(JSON.stringify(view.persisted).includes('plugin-test-token-QUOKKA-xyz'), false)
  assert.equal(JSON.stringify(view.persisted).includes('formConflict'), false)
  assert.equal(Object.keys(view.persisted.plugin).some((name) => name.includes('conflict')), false)
  await view.unmount()
})

test('a typed secret is remembered only as a flag in the draft, and the flag reads as cleared once the secret is gone', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'credential:vcrd_1'
  editSecret(key, 'plugin-test-token-QUOKKA', BASE, BASE, T1)
  assert.equal(read(secretDrafts)[key], 'plugin-test-token-QUOKKA')
  assert.equal(secretCleared(key), false)
  await view.rerender()
  const persisted = view.persisted.plugin['forms.drafts'] as Record<string, unknown>
  assert.deepEqual(persisted[key], { form: BASE, base: BASE, baseStamp: T1, hadSecret: true })
  assert.equal(JSON.stringify(view.persisted).includes('plugin-test-token-QUOKKA'), false)
  // Une saisie suivante garde le drapeau.
  editForm(key, { ...BASE, name: 'Renamed' }, BASE, T1)
  assert.equal(readForm(key, BASE, T1).dirty, true)
  // Le panneau a perdu le secret (redémarrage) : le drapeau reste, le secret manque.
  set(secretDrafts, {})
  assert.equal(secretCleared(key), true)
  // Un secret retapé puis vidé retire le drapeau.
  editSecret(key, 'again', BASE, BASE, T1)
  editSecret(key, '', BASE, BASE, T1)
  assert.equal(secretCleared(key), false)
  assert.equal(Object.hasOwn((read(formDrafts)[key] ?? {}) as object, 'hadSecret'), false)
  await view.unmount()
})

test('clearForm forgets the secret flag, the raw texts and the touched fields of that form only', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'credential:vcrd_1'
  const other = 'credential:vcrd_2'
  editSecret(key, 'plugin-test-token-QUOKKA', BASE, BASE, T1)
  setFieldText(key, 'hosts', 'a.example.com')
  setFieldText(other, 'hosts', 'b.example.com')
  touchField(key, 'name')
  touchField(other, 'name')
  assert.equal(isTouched(key, 'name'), true)
  assert.equal(fieldText(key, 'hosts', 'derived'), 'a.example.com')
  clearForm(key)
  assert.equal(secretCleared(key), false)
  assert.deepEqual(read(secretDrafts), {})
  assert.equal(isTouched(key, 'name'), false)
  assert.equal(fieldText(key, 'hosts', 'derived'), 'derived')
  assert.equal(isTouched(other, 'name'), true)
  assert.equal(fieldText(other, 'hosts', 'derived'), 'b.example.com')
  dropFieldText(other, 'hosts')
  assert.equal(fieldText(other, 'hosts', 'derived'), 'derived')
  await view.unmount()
})
