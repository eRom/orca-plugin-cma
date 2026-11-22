import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions'
import { expect, test } from 'bun:test'
import { SESSION_CREATE_WAIT_MS, type SessionCreateInput } from '../protocol'
import { describeError, type ClientStore } from './client'
import { createSessionHandlers, toCreateParams, toSessionDetail, toSessionRow } from './session-actions'

const baseInput: SessionCreateInput = {
  agentId: 'agent_x',
  environmentId: 'env_x',
  title: null,
  vaultIds: [],
  memoryStoreIds: [],
  budgetDollars: null,
  firstMessage: null
}

test('toCreateParams builds a capped session', () => {
  const params = toCreateParams({
    ...baseInput,
    title: 'plugin-test',
    memoryStoreIds: ['memstore_1'],
    budgetDollars: '0.50',
    firstMessage: 'hi',
    metadata: { purpose: 'plugin-test' }
  })
  expect(params.budget?.max_list_cost.amount).toBe('50')
  expect(params.budget?.max_list_cost.currency).toBe('USD')
  expect(params.resources?.[0]?.type).toBe('memory_store')
  const event = params.initial_events?.[0]
  expect(event?.type).toBe('user.message')
  expect(event && 'content' in event ? event.content[0] : null).toEqual({ type: 'text', text: 'hi' })
  expect(params.metadata?.purpose).toBe('plugin-test')
  expect(params.agent).toBe('agent_x')
  expect(params.environment_id).toBe('env_x')
})

test('toCreateParams omits empty parts', () => {
  const params = toCreateParams({ ...baseInput, firstMessage: '  ', title: '' })
  expect('budget' in params).toBe(false)
  expect('initial_events' in params).toBe(false)
  expect(params.title).toBe(null)
})

test('toCreateParams rejects an invalid budget instead of creating an uncapped session', () => {
  expect(() => toCreateParams({ ...baseInput, budgetDollars: 'abc' })).toThrow()
})

function fakeSession(over: Partial<BetaManagedAgentsSession>): BetaManagedAgentsSession {
  return {
    id: 'sesn_1',
    agent: { id: 'agent_1', name: 'Writer', version: 3 },
    archived_at: null,
    budget: null,
    created_at: '2026-11-22T10:00:00Z',
    environment_id: 'env_1',
    metadata: {},
    resources: [],
    status: 'running',
    title: 'Hello',
    updated_at: '2026-11-22T10:05:00Z',
    usage: {},
    vault_ids: ['vlt_1'],
    ...over
  } as unknown as BetaManagedAgentsSession
}

test('toSessionRow reads cost and budget', () => {
  const row = toSessionRow(
    fakeSession({
      usage: { list_cost: { amount: '1', currency: 'USD' } },
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } }
    }),
    null
  )
  expect(row.cost?.minor).toBe('1')
  expect(row.budget?.minor).toBe('50')
  expect(row.badge).toBe('running')
  expect(row.status).toBe('running')
  expect(row.agentName).toBe('Writer')
  expect(row.pendingApprovals).toBe(0)
})

test('toSessionRow leaves cost and budget empty when absent', () => {
  const row = toSessionRow(fakeSession({ status: 'idle' }), null)
  expect(row.cost).toBe(null)
  expect(row.budget).toBe(null)
  expect(row.badge).toBe('idle')
})

test('toSessionRow takes the badge and approvals from the idle classification', () => {
  const row = toSessionRow(fakeSession({ status: 'idle' }), { badge: 'needs_approval', pendingApprovals: 2 })
  expect(row.badge).toBe('needs_approval')
  expect(row.pendingApprovals).toBe(2)
  expect(row.status).toBe('idle')
})

test('toSessionDetail lists resources and the environment name', () => {
  const detail = toSessionDetail(
    fakeSession({
      resources: [
        { id: 'r1', type: 'memory_store', memory_store_id: 'memstore_1', name: 'Notes', access: 'read_only' },
        { id: 'r2', type: 'github_repository', url: 'https://github.com/a/b', mount_path: '/w/b' }
      ] as never
    }),
    'Sandbox',
    null
  )
  expect(detail.environmentName).toBe('Sandbox')
  expect(detail.environmentId).toBe('env_1')
  expect(detail.agentVersion).toBe(3)
  expect(detail.vaultIds).toEqual(['vlt_1'])
  expect(detail.resources.length).toBe(2)
  expect(detail.resources[0]).toBe('Memory store Notes (read only)')
  expect(detail.resources[1]).toBe('Repository https://github.com/a/b')
})

// Une BadRequestError de l'API portant le corps JSON donné (`error.error`).
function badRequest(body: unknown): InstanceType<typeof Anthropic.BadRequestError> {
  return new Anthropic.BadRequestError(400, body as object, 'budget refused', new Headers())
}

test('maps budget_create_only', () => {
  const error = badRequest(BUDGET_CREATE_ONLY_BODY)
  expect(describeError(error).code).toBe('budget_create_only')
})

test('maps budget_not_raised', () => {
  expect(describeError(badRequest(BUDGET_NOT_RAISED_BODY)).code).toBe('budget_not_raised')
})

test('maps model_not_budgetable', () => {
  expect(describeError(badRequest(MODEL_NOT_BUDGETABLE_BODY)).code).toBe('model_not_budgetable')
})

test('a bad request without a budget reason stays other', () => {
  const body = { type: 'error', error: { type: 'invalid_request_error', message: 'Cannot modify archived session' } }
  expect(describeError(badRequest(body)).code).toBe('other')
})

// CAPTURÉ (réel) le 22/11 : `sessions.update(id, { budget })` sur une session créée sans budget,
// corps complet de la BadRequestError (req_011ChHmZNKo16Auq3qGxBojF). Il ne porte AUCUN code
// snake_case, seulement ce message : `describeError` s'appuie donc sur le texte.
const BUDGET_CREATE_ONLY_BODY = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message:
      "`budget` can only be attached when a session is created: a session that has no budget cannot gain one, and removing a budget is permanent. A session's existing budget may be raised, lowered, or removed."
  },
  request_id: 'req_011ChHmZNKo16Auq3qGxBojF'
}

// SYNTHÉTIQUES, jamais observés : le corps réel de ces deux refus n'a pas pu être capturé (coût
// toujours à 0 cent, aucun modèle non budgétable à portée). On y place le code à deux endroits
// différents pour tester la recherche du nom du code dans tout le corps, rien de plus.
const BUDGET_NOT_RAISED_BODY = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Budget must be raised (budget_not_raised)' }
}
const MODEL_NOT_BUDGETABLE_BODY = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'No public price', details: [{ reason: 'model_not_budgetable' }] }
}

// Faux client : `store.get()` rend un objet qui note les événements envoyés et les paramètres de liste,
// et ne sert les sessions archivées que si `include_archived` est vrai (comme l'API).
function fakeStore(sessions: unknown[] = []) {
  const sent: unknown[] = []
  const listParams: { include_archived?: boolean }[] = []
  const client = {
    beta: {
      sessions: {
        events: {
          send: async (_id: string, params: { events: unknown[] }) => {
            sent.push(...params.events)
          }
        },
        list: (params: { include_archived?: boolean } = {}) => ({
          async *[Symbol.asyncIterator]() {
            listParams.push(params)
            for (const session of sessions) {
              if (params.include_archived === true || (session as { archived_at?: string }).archived_at == null) yield session
            }
          }
        })
      }
    }
  }
  const store = { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
  return { store, sent, listParams }
}

test('confirm sends deny_message only on a non-empty denial', async () => {
  const { store, sent } = fakeStore()
  const handlers = createSessionHandlers(store)
  await handlers.confirm({ sessionId: 's', toolUseId: 't1', allow: true, denyMessage: 'ignored' })
  await handlers.confirm({ sessionId: 's', toolUseId: 't2', allow: false, denyMessage: '  ' })
  await handlers.confirm({ sessionId: 's', toolUseId: 't3', allow: false, denyMessage: 'too risky' })
  expect(sent).toEqual([
    { type: 'user.tool_confirmation', tool_use_id: 't1', result: 'allow' },
    { type: 'user.tool_confirmation', tool_use_id: 't2', result: 'deny' },
    { type: 'user.tool_confirmation', tool_use_id: 't3', result: 'deny', deny_message: 'too risky' }
  ])
})

test('testSpend counts only plugin-test sessions and sums a missing cost as zero', async () => {
  const { store } = fakeStore([
    { metadata: { purpose: 'plugin-test' }, usage: { list_cost: { amount: '30', currency: 'USD' } } },
    { metadata: { purpose: 'plugin-test' }, usage: {} },
    { metadata: {}, usage: { list_cost: { amount: '999', currency: 'USD' } } }
  ])
  const result = await createSessionHandlers(store).testSpend()
  expect(result).toEqual({ ok: true, value: { sessions: 2, total: { minor: '30', currency: 'USD' } } })
})

// Garde du plafond de dépense : une session de test archivée coûte encore, elle doit être comptée.
test('testSpend asks for archived sessions and counts their cost', async () => {
  const { store, listParams } = fakeStore([
    { metadata: { purpose: 'plugin-test' }, archived_at: null, usage: { list_cost: { amount: '30', currency: 'USD' } } },
    {
      metadata: { purpose: 'plugin-test' },
      archived_at: '2026-11-22T10:00:00Z',
      usage: { list_cost: { amount: '20', currency: 'USD' } }
    }
  ])
  const result = await createSessionHandlers(store).testSpend()
  expect(listParams.length).toBe(1)
  expect(listParams[0]?.include_archived).toBe(true)
  expect(result).toEqual({ ok: true, value: { sessions: 2, total: { minor: '50', currency: 'USD' } } })
})

test('raiseBudget refuses an invalid amount without calling the API', async () => {
  const { store } = fakeStore()
  const result = await createSessionHandlers(store).raiseBudget({ sessionId: 's', dollars: 'lots' })
  expect(result.ok).toBe(false)
})

const CAP = { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } } as const

test('toSessionRow keeps budget_reached only while the cost has reached the budget', () => {
  const reached = { badge: 'budget_reached', pendingApprovals: 0 } as const
  const at = (cost: string, budget: { type: 'limit'; max_list_cost: { amount: string; currency: string } } | null) =>
    toSessionRow(
      fakeSession({ status: 'idle', usage: { list_cost: { amount: cost, currency: 'USD' } }, budget } as never),
      reached
    ).badge
  expect(at('50', CAP)).toBe('budget_reached')
  expect(at('51', CAP)).toBe('budget_reached')
  // Budget relevé depuis le dernier arrêt : le dernier `status_idle` est périmé.
  expect(at('50', { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } })).toBe('idle')
  expect(at('49', CAP)).toBe('idle')
  expect(at('0', null)).toBe('idle')
})

test('toSessionRow ignores an idle classification on a session that is no longer idle', () => {
  const row = toSessionRow(fakeSession({ status: 'running' }), { badge: 'needs_approval', pendingApprovals: 2 })
  expect(row.badge).toBe('running')
  expect(row.pendingApprovals).toBe(0)
})

/** Faux client de détail : une session lisible et un environnement nommé ou illisible. */
function detailStore(session: unknown, environment: 'ok' | 'fails' = 'ok') {
  const calls = { retrieve: 0, update: [] as unknown[] }
  const client = {
    beta: {
      sessions: {
        retrieve: async () => {
          calls.retrieve++
          return session
        },
        update: async (_id: string, params: unknown) => {
          calls.update.push(params)
          return session
        }
      },
      environments: {
        retrieve: async () => {
          if (environment === 'fails') throw new Error('environment unreadable')
          return { name: 'Sandbox' }
        }
      }
    }
  }
  return { calls, store: { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore }
}

test('detail reuses the poller classification, bounded by the cost against the budget', async () => {
  const reached = { badge: 'budget_reached', pendingApprovals: 0 } as const
  const capped = fakeSession({ status: 'idle', usage: { list_cost: { amount: '50', currency: 'USD' } }, budget: CAP } as never)
  const atCap = await createSessionHandlers(detailStore(capped).store, () => reached).detail({ sessionId: 'sesn_1' })
  expect(atCap.ok && atCap.value.badge).toBe('budget_reached')
  // Sans classement du sondeur, le badge suit le statut.
  const unknown = await createSessionHandlers(detailStore(capped).store, () => null).detail({ sessionId: 'sesn_1' })
  expect(unknown.ok && unknown.value.badge).toBe('idle')
  const raised = fakeSession({
    status: 'idle',
    usage: { list_cost: { amount: '50', currency: 'USD' } },
    budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } }
  } as never)
  const afterRaise = await createSessionHandlers(detailStore(raised).store, () => reached).detail({ sessionId: 'sesn_1' })
  expect(afterRaise.ok && afterRaise.value.badge).toBe('idle')
})

test('raiseBudget builds the detail from the updated session, without a second read of it', async () => {
  const raised = fakeSession({
    status: 'idle',
    usage: { list_cost: { amount: '50', currency: 'USD' } },
    budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } }
  } as never)
  const { store, calls } = detailStore(raised)
  const result = await createSessionHandlers(store, () => ({ badge: 'budget_reached', pendingApprovals: 0 })).raiseBudget({
    sessionId: 'sesn_1',
    dollars: '1.00'
  })
  expect(calls.update).toEqual([{ budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } } }])
  expect(calls.retrieve).toBe(0)
  expect(result.ok && result.value.budget?.minor).toBe('100')
  expect(result.ok && result.value.badge).toBe('idle')
  expect(result.ok && result.value.environmentName).toBe('Sandbox')
})

test('raiseBudget still reports success when the environment name cannot be read', async () => {
  const { store } = detailStore(fakeSession({ status: 'idle' }), 'fails')
  const result = await createSessionHandlers(store).raiseBudget({ sessionId: 'sesn_1', dollars: '1.00' })
  expect(result.ok && result.value.environmentName).toBe(null)
})

// Une session est facturée : un nouvel essai automatique du SDK après un délai dépassé dupliquerait la facturation.
test('billed calls never retry on their own', async () => {
  const optionsSeen: unknown[] = []
  const client = {
    beta: {
      sessions: {
        create: async (_params: unknown, options: unknown) => {
          optionsSeen.push(options)
          return { id: 'sesn_new' }
        },
        events: {
          send: async (_id: string, _params: unknown, options: unknown) => {
            optionsSeen.push(options)
          }
        }
      }
    }
  }
  const store = { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
  const handlers = createSessionHandlers(store)
  await handlers.create(baseInput)
  await handlers.send({ sessionId: 's', text: 'hi' })
  await handlers.confirm({ sessionId: 's', toolUseId: 't', allow: true, denyMessage: null })
  await handlers.interrupt({ sessionId: 's' })
  expect(optionsSeen.map((options) => (options as { maxRetries?: number }).maxRetries)).toEqual([0, 0, 0, 0])
})

function creatingStore(create: (params: unknown, options: { timeout?: number }) => Promise<unknown>): ClientStore {
  const client = { beta: { sessions: { create } } }
  return { get: async () => client, reset() {}, hasKey: async () => true } as unknown as ClientStore
}

// Le panneau cesse d'attendre au bout de SESSION_CREATE_WAIT_MS : un appel encore en route à ce moment
// laisserait la personne relancer, et la session serait facturée deux fois.
test('session creation gives up before the panel stops waiting', async () => {
  let timeout: number | undefined
  const store = creatingStore(async (_params, options) => {
    timeout = options.timeout
    return { id: 'sesn_new' }
  })
  await createSessionHandlers(store).create(baseInput)
  expect(typeof timeout).toBe('number')
  expect((timeout ?? Infinity) < SESSION_CREATE_WAIT_MS).toBe(true)
})

test('a timed-out creation warns that the session may exist', async () => {
  const store = creatingStore(async () => {
    throw new Anthropic.APIConnectionTimeoutError()
  })
  const result = await createSessionHandlers(store).create(baseInput)
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error.includes('sessions list')).toBe(true)
})

// Une connexion coupée après l'envoi est aussi ambiguë qu'un délai dépassé : la session a pu être créée.
test('a creation cut off mid-request warns that the session may exist', async () => {
  const store = creatingStore(async () => {
    throw new Anthropic.APIConnectionError({ message: 'other side closed' })
  })
  const result = await createSessionHandlers(store).create(baseInput)
  expect(!result.ok && result.error.includes('sessions list')).toBe(true)
})

// CONSTRUITS d'après la doc (https://platform.claude.com/docs/en/managed-agents/budgets), jamais capturés :
// seuls les messages y sont documentés, le corps réel de ces refus reste inconnu.
test('maps the documented model_not_budgetable message', () => {
  const body = {
    type: 'error',
    error: { type: 'invalid_request_error', message: 'no list price is available for the model claude-example-1' }
  }
  expect(describeError(badRequest(body)).code).toBe('model_not_budgetable')
})

test("maps the documented budget_not_raised message", () => {
  const body = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: "budget.max_list_cost must be greater than the session's consumed list cost"
    }
  }
  expect(describeError(badRequest(body)).code).toBe('budget_not_raised')
})
