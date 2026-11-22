import { read, set } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import { clearForm, editForm, formConflict, formDrafts, formKey, readForm, secretDrafts } from './form-state'

type EnvForm = { name: string; packages: { pip: string[] }; metadata: { key: string; value: string }[] }

const BASE: EnvForm = { name: 'Sandbox', packages: { pip: ['requests'] }, metadata: [{ key: 'team', value: 'infra' }] }

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
  assert.deepEqual(readForm(key, BASE), { form: BASE, dirty: false })
  const edited: EnvForm = { ...BASE, name: 'Sandbox 2' }
  editForm(key, edited)
  assert.deepEqual(readForm(key, BASE), { form: edited, dirty: true })
  clearForm(key)
  assert.deepEqual(readForm(key, BASE), { form: BASE, dirty: false })
  assert.deepEqual(read(formDrafts), {})
  await view.unmount()
})

test('a kept entry equal to the base in depth is not dirty', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, structuredClone(BASE))
  assert.equal(readForm(key, BASE).dirty, false)
  editForm(key, { ...structuredClone(BASE), packages: { pip: ['requests', 'numpy'] } })
  assert.equal(readForm(key, BASE).dirty, true)
  await view.unmount()
})

test('drafts persist for the plugin while secret drafts and conflicts never do', async () => {
  const view = await mount(Probe, { host: mockHost() })
  const key = 'environment:env_1'
  editForm(key, { ...BASE, name: 'Sandbox 2' })
  set(secretDrafts, { [key]: 'plugin-test-token-QUOKKA-xyz' })
  set(formConflict, { [key]: true })
  await view.rerender()
  const persisted = view.persisted.plugin['forms.drafts'] as Record<string, unknown>
  assert.deepEqual(persisted[key], { ...BASE, name: 'Sandbox 2' })
  assert.equal(JSON.stringify(view.persisted).includes('plugin-test-token-QUOKKA-xyz'), false)
  assert.equal(JSON.stringify(view.persisted).includes('formConflict'), false)
  assert.equal(Object.keys(view.persisted.plugin).some((name) => name.includes('conflict')), false)
  await view.unmount()
})
