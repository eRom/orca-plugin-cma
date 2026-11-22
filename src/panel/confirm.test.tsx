import { Stack } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import { archiveQuestion, ConfirmAction, deleteQuestion } from './confirm'

let confirmed = { archive: 0, delete: 0 }
let release: (() => void) | null = null

function Both() {
  return (
    <Stack>
      <ConfirmAction
        actionKey="archive"
        label="Archive"
        question={archiveQuestion('Sandbox')}
        confirmLabel="Confirm archive"
        onConfirm={async () => {
          confirmed.archive += 1
        }}
      />
      <ConfirmAction
        actionKey="delete"
        label="Delete"
        question={deleteQuestion('Sandbox')}
        confirmLabel="Confirm delete"
        onConfirm={async () => {
          confirmed.delete += 1
        }}
      />
    </Stack>
  )
}

function Slow() {
  return (
    <ConfirmAction
      actionKey="slow"
      label="Archive"
      question="Archive slow?"
      confirmLabel="Confirm archive"
      onConfirm={() =>
        new Promise<void>((resolve) => {
          release = resolve
        })
      }
    />
  )
}

test('questions name the object and cut it at 200 bytes', () => {
  assert.equal(archiveQuestion('Sandbox'), "Archive Sandbox? This can't be undone.")
  assert.equal(deleteQuestion('Sandbox'), "Delete Sandbox for good? This can't be undone.")
  assert.equal(archiveQuestion('x'.repeat(500)), `Archive ${'x'.repeat(200)}? This can't be undone.`)
})

test('a first press shows the question and Cancel removes it without confirming', async () => {
  confirmed = { archive: 0, delete: 0 }
  const view = await mount(Both, { host: mockHost() })
  assert.equal(view.find({ type: 'Callout' }), null)
  await view.press({ role: 'button', text: 'Archive' })
  assert.ok(view.find({ type: 'Callout', text: /Archive Sandbox\? This can't be undone\./ }))
  assert.equal(view.find({ role: 'button', text: 'Archive' }), null)
  await view.press({ role: 'button', text: 'Cancel' })
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.ok(view.find({ role: 'button', text: 'Archive' }))
  assert.equal(confirmed.archive, 0)
  await view.unmount()
})

test('Confirm archive calls onConfirm once and closes the question', async () => {
  confirmed = { archive: 0, delete: 0 }
  const view = await mount(Both, { host: mockHost() })
  await view.press({ role: 'button', text: 'Archive' })
  await view.press({ role: 'button', text: 'Confirm archive' })
  assert.equal(confirmed.archive, 1)
  assert.equal(confirmed.delete, 0)
  assert.equal(view.find({ type: 'Callout' }), null)
  await view.unmount()
})

test('opening a second confirmation closes the first', async () => {
  confirmed = { archive: 0, delete: 0 }
  const view = await mount(Both, { host: mockHost() })
  await view.press({ role: 'button', text: 'Archive' })
  await view.press({ role: 'button', text: 'Delete' })
  assert.equal(view.findAll({ type: 'Callout' }).length, 1)
  assert.ok(view.find({ type: 'Callout', text: /Delete Sandbox for good\?/ }))
  assert.ok(view.find({ role: 'button', text: 'Archive' }))
  await view.unmount()
})

test('the confirm button stays disabled while onConfirm runs', async () => {
  const view = await mount(Slow, { host: mockHost() })
  await view.press({ role: 'button', text: 'Archive' })
  const pressed = view.press({ role: 'button', text: 'Confirm archive' })
  await view.rerender()
  const button = view.find({ role: 'button', text: 'Confirm archive' })
  assert.ok(button)
  assert.equal(JSON.stringify(view.tree()).includes('"disabled":true'), true)
  release?.()
  await pressed
  await view.settled()
  assert.equal(view.find({ type: 'Callout' }), null)
  await view.unmount()
})
