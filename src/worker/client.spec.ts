import Anthropic from '@anthropic-ai/sdk'
import { expect, test } from 'bun:test'
import { createClientStore, describeError, workspaceInfo } from './client'

test('describeError maps API errors', () => {
  const error = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
  expect(describeError(error)).toEqual({ message: 'The API key was rejected (401).', code: 'unauthorized' })
})

test('describeError maps unknown errors to other', () => {
  expect(describeError(new Error('x'))).toEqual({ message: 'x', code: 'other' })
})

test('workspaceInfo without key', async () => {
  // `mockHost` n'expose pas d'API de secrets : un faux littéral suffit, et le fait qu'il
  // ne contienne aucune clé doit éviter tout appel réseau.
  const store = createClientStore({ get: async () => null, set: async () => {}, delete: async () => {} })
  expect(await workspaceInfo(store)).toEqual({
    hasKey: false,
    keyRejected: false,
    workspaceId: null,
    organizationName: null
  })
})
