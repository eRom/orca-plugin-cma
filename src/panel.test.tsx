import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const WITH_KEY = {
  hasKey: true,
  keyRejected: false,
  workspaceId: 'wrkspc_x',
  organizationName: "Romain's Individual Org"
}

test('shows the key form without a key', async () => {
  const host = mockHost({
    requests: { 'workspace.info': { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null } }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ label: 'API key' }))
  assert.equal(view.find({ text: 'Configurations' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the workspace line with a key', async () => {
  const host = mockHost({ requests: { 'workspace.info': WITH_KEY } })
  const view = await mount(panel, { host })
  // La section workspace est repliée par défaut quand la clé est bonne.
  await view.toggle({ type: 'Collapsible', text: /Anthropic workspace/ })
  assert.ok(view.find({ text: /wrkspc_x/ }))
  assert.ok(view.find({ role: 'button', text: 'Forget key' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('shows the key form again when the key is rejected', async () => {
  const host = mockHost({
    requests: {
      'workspace.info': { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ type: 'Callout', text: /The API key was rejected \(401\)\./ }))
  assert.ok(view.find({ label: 'API key' }))
  await view.unmount()
})
