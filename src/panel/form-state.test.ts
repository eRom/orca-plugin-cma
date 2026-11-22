import { read, set } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import { clearForm, editForm, formConflict, formDrafts, formKey, readForm, secretDrafts } from './form-state'

type EnvForm = { name: string; packages: { pip: string[] }; metadata: { key: string; value: string }[] }

const BASE: EnvForm = { name: 'Sandbox', packages: { pip: ['requests'] }, metadata: [{ key: 'team', value: 'infra' }] }
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
  assert.deepEqual(readForm(key, BASE, T1), { form: BASE, dirty: false, baseUpdatedAt: T1, stale: false })
  const edited: EnvForm = { ...BASE, name: 'Sandbox 2' }
  editForm(key, edited, T1)
  assert.deepEqual(readForm(key, BASE, T1), { form: edited, dirty: true, baseUpdatedAt: T1, stale: false })
  clearForm(key)
  assert.deepEqual(readForm(key, BASE, T1), { form: BASE, dirty: false, baseUpdatedAt: T1, stale: false })
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a draft keeps the baseUpdatedAt of its first edit and reads as stale against a newer version', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'First' }, T1)
  // Une saisie suivante, même passée avec un horodatage plus récent, garde celui de la première.
  editForm(key, { ...BASE, name: 'Second' }, T2)
  assert.deepEqual(readForm(key, BASE, T1), { form: { ...BASE, name: 'Second' }, dirty: true, baseUpdatedAt: T1, stale: false })
  const reread = readForm(key, BASE, T2)
  assert.equal(reread.baseUpdatedAt, T1)
  assert.equal(reread.stale, true)
  clearForm(key)
  editForm(key, { ...BASE, name: 'Third' }, T2)
  assert.equal(readForm(key, BASE, T2).baseUpdatedAt, T2)
  await view.unmount()
})

test('a creation draft has no base timestamp and is never stale', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:new'
  editForm(key, { ...BASE, name: 'New one' })
  assert.deepEqual(readForm(key, BASE), { form: { ...BASE, name: 'New one' }, dirty: true, baseUpdatedAt: null, stale: false })
  await view.unmount()
})

test('a draft persisted in the old shape (the form alone) is ignored', async () => {
  const stale: unknown = { ...BASE, name: 'Old shape' }
  const view = await mount(Probe, { host: mockHost(), persisted: { plugin: { 'forms.drafts': { 'environment:env_1': stale } } } })
  assert.deepEqual(readForm('environment:env_1', BASE, T1), { form: BASE, dirty: false, baseUpdatedAt: T1, stale: false })
  // Une première saisie la remplace par une saisie à la forme courante.
  editForm('environment:env_1', { ...BASE, name: 'Fresh' }, T1)
  assert.equal(readForm('environment:env_1', BASE, T1).dirty, true)
  await view.unmount()
})

test('a kept entry equal to the base in depth is not dirty', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, structuredClone(BASE), T1)
  assert.equal(readForm(key, BASE, T1).dirty, false)
  editForm(key, { ...structuredClone(BASE), packages: { pip: ['requests', 'numpy'] } }, T1)
  assert.equal(readForm(key, BASE).dirty, true)
  await view.unmount()
})

test('drafts persist for the plugin while secret drafts and conflicts never do', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'Sandbox 2' }, T1)
  set(secretDrafts, { [key]: 'plugin-test-token-QUOKKA-xyz' })
  set(formConflict, { [key]: true })
  await view.rerender()
  const persisted = view.persisted.plugin['forms.drafts'] as Record<string, unknown>
  assert.deepEqual(persisted[key], { form: { ...BASE, name: 'Sandbox 2' }, baseUpdatedAt: T1 })
  assert.equal(JSON.stringify(view.persisted).includes('plugin-test-token-QUOKKA-xyz'), false)
  assert.equal(JSON.stringify(view.persisted).includes('formConflict'), false)
  assert.equal(Object.keys(view.persisted.plugin).some((name) => name.includes('conflict')), false)
  await view.unmount()
})
