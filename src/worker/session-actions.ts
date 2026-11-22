// Actions sur une session (envoi, accord, interruption, création, budget) et garde de dépense des
// sessions de test. Les conversions sont pures ; les handlers n'ont que l'appel réseau en plus.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMonetaryAmount } from '@anthropic-ai/sdk/resources/beta/beta'
import type {
  BetaManagedAgentsSession,
  SessionCreateParams
} from '@anthropic-ai/sdk/resources/beta/sessions/sessions'
import type {
  Money,
  SessionBadge,
  SessionCreateInput,
  SessionDetail,
  SessionRow,
  ApiResult
} from '../protocol'
import { dollarsToMinor, sumMinor } from '../shared/money'
import { attempt, type ClientStore } from './client'

/** Classement d'une session `idle` (accords en attente, budget atteint...) ; fourni par le sondeur. */
export type IdleClassification = { badge: SessionBadge; pendingApprovals: number }

/** Un budget en dollars saisis vers le corps de l'API ; lève sur une saisie invalide. */
function budgetOf(dollars: string): { type: 'limit'; max_list_cost: BetaMonetaryAmount } {
  const amount = dollarsToMinor(dollars)
  if (amount === null) {
    throw new Error('The budget must be a positive amount in dollars, with at most two decimals.')
  }
  return { type: 'limit', max_list_cost: { amount, currency: 'USD' } }
}

export function toCreateParams(input: SessionCreateInput): SessionCreateParams {
  const params: SessionCreateParams = {
    agent: input.agentId,
    environment_id: input.environmentId,
    title: input.title?.trim() ? input.title.trim() : null
  }
  if (input.budgetDollars !== null) {
    params.budget = budgetOf(input.budgetDollars)
  }
  if (input.vaultIds.length > 0) {
    params.vault_ids = input.vaultIds
  }
  if (input.memoryStoreIds.length > 0) {
    params.resources = input.memoryStoreIds.map((memory_store_id) => ({ type: 'memory_store', memory_store_id }))
  }
  const firstMessage = input.firstMessage?.trim()
  if (firstMessage) {
    params.initial_events = [{ type: 'user.message', content: [{ type: 'text', text: firstMessage }] }]
  }
  if (input.metadata !== undefined) {
    params.metadata = input.metadata
  }
  return params
}

function toMoney(amount: BetaMonetaryAmount | null | undefined): Money | null {
  return amount ? { minor: amount.amount, currency: amount.currency } : null
}

/** Vrai quand le coût a rejoint le plafond (comparaison exacte en unités mineures). */
function capReached(cost: Money | null, budget: Money | null): boolean {
  return budget !== null && BigInt(cost?.minor ?? '0') >= BigInt(budget.minor)
}

export function toSessionRow(session: BetaManagedAgentsSession, idle: IdleClassification | null): SessionRow {
  const cost = toMoney(session.usage.list_cost)
  const budget = toMoney(session.budget?.max_list_cost)
  // Un classement `idle` ne vaut que pour une session `idle` : une autre l'a déjà quitté.
  const applied = session.status === 'idle' ? idle : null
  // Sans classement `idle`, le badge reprend le statut tel quel.
  let badge: SessionBadge = applied?.badge ?? session.status
  // Le classement garde le dernier arrêt tant qu'aucun tour ne tourne : un budget relevé depuis laisserait
  // « Budget reached » collé. Il ne vaut que tant que le coût a rejoint le plafond.
  if (badge === 'budget_reached' && !capReached(cost, budget)) {
    badge = 'idle'
  }
  // À l'inverse, un tour fini normalement pile au plafond laisse un dernier arrêt `end_turn` alors que l'API
  // refuse déjà tout nouvel événement (AC-13 rejoué le 22/11) : seul le coût le dit.
  if (session.status === 'idle' && capReached(cost, budget)) {
    badge = 'budget_reached'
  }
  return {
    id: session.id,
    title: session.title,
    agentId: session.agent.id,
    agentName: session.agent.name,
    status: session.status,
    badge,
    cost,
    budget,
    updatedAt: session.updated_at,
    pendingApprovals: applied?.pendingApprovals ?? 0
  }
}

/** Une ligne lisible par ressource montée. */
function describeResource(resource: BetaManagedAgentsSession['resources'][number]): string {
  switch (resource.type) {
    case 'github_repository':
      return `Repository ${resource.url}`
    case 'file':
      return `File ${resource.file_id} at ${resource.mount_path}`
    case 'memory_store': {
      const access = resource.access === 'read_only' ? ' (read only)' : ''
      return `Memory store ${resource.name ?? resource.memory_store_id}${access}`
    }
  }
}

export function toSessionDetail(
  session: BetaManagedAgentsSession,
  environmentName: string | null,
  idle: IdleClassification | null
): SessionDetail {
  return {
    ...toSessionRow(session, idle),
    agentVersion: session.agent.version,
    environmentId: session.environment_id,
    environmentName,
    vaultIds: session.vault_ids,
    resources: session.resources.map(describeResource),
    createdAt: session.created_at
  }
}

type Client = Awaited<ReturnType<ClientStore['get']>>

/** Le nom de l'environnement est un complément : son échec ne fait pas perdre le détail. */
async function detailOf(client: Client, session: BetaManagedAgentsSession, idleOf: IdleLookup): Promise<SessionDetail> {
  const environmentName = await client.beta.environments.retrieve(session.environment_id).then(
    (environment) => environment.name,
    () => null
  )
  // Le classement `idle` vient du sondeur : sans lui, le badge suit le statut.
  return toSessionDetail(session, environmentName, idleOf(session.id))
}

async function readDetail(client: Client, sessionId: string, idleOf: IdleLookup): Promise<SessionDetail> {
  return detailOf(client, await client.beta.sessions.retrieve(sessionId), idleOf)
}

/**
 * Une session est facturée : le SDK ne réessaie jamais seul un envoi ou une création dont la réponse
 * se perd (un nouvel essai après un délai dépassé dupliquerait le message ou la session).
 */
const NO_RETRY = { maxRetries: 0 } as const

/**
 * Une création abandonne bien avant que le panneau cesse d'attendre (SESSION_CREATE_WAIT_MS) : sinon il
 * rend la main pendant que l'appel court encore, la personne relance, et deux sessions sont facturées.
 * Le SDK 1.8.0 arrête `timeout` à l'arrivée des en-têtes : un signal, créé à chaque appel, borne aussi la
 * lecture du corps.
 */
const CREATE_TIMEOUT_MS = 90_000
const CREATE_OPTIONS = { ...NO_RETRY, timeout: CREATE_TIMEOUT_MS } as const

export const CREATE_UNCONFIRMED =
  'The API did not confirm the creation. The session may still have been created: check the sessions list before trying again.'

/** Un envoi dont la réponse se perd a pu partir : le dire évite que la personne renvoie le même message. */
export const SEND_UNCONFIRMED = 'The message may have been sent: check the thread.'
export const CONFIRM_UNCONFIRMED = 'Your answer may have been sent: check the thread.'

/**
 * Une fois la requête partie, seule une réponse du serveur (une `APIError` au `status` numérique) prouve qu'elle
 * a échoué. Tout le reste (connexion coupée, délai, signal expiré, erreur brute du fetch) laisse un doute : le SDK
 * 1.8.0 n'enveloppe en `APIConnectionError` que les échecs avant les en-têtes, une coupure pendant le corps
 * remonte brute (`TypeError`, `DOMException`). Le doute devient le message « non confirmé », la cause est gardée.
 */
function unconfirmedUnlessAnswered(error: unknown, message: string): unknown {
  return error instanceof Anthropic.APIError && typeof error.status === 'number'
    ? error
    : new Error(message, { cause: error })
}

/** Le classement `idle` que le sondeur connaît d'une session ; null quand il n'en a pas. */
export type IdleLookup = (sessionId: string) => IdleClassification | null

export type SessionHandlers = {
  send(input: { sessionId: string; text: string }): Promise<ApiResult<null>>
  confirm(input: {
    sessionId: string
    toolUseId: string
    allow: boolean
    denyMessage: string | null
  }): Promise<ApiResult<null>>
  interrupt(input: { sessionId: string }): Promise<ApiResult<null>>
  create(input: SessionCreateInput): Promise<ApiResult<{ sessionId: string }>>
  raiseBudget(input: { sessionId: string; dollars: string }): Promise<ApiResult<SessionDetail>>
  detail(input: { sessionId: string }): Promise<ApiResult<SessionDetail>>
  testSpend(): Promise<ApiResult<{ sessions: number; total: Money | null }>>
}

export function createSessionHandlers(store: ClientStore, idleOf: IdleLookup = () => null): SessionHandlers {
  return {
    send: ({ sessionId, text }) =>
      attempt(store, async (client) => {
        try {
          await client.beta.sessions.events.send(
            sessionId,
            { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] },
            NO_RETRY
          )
        } catch (error) {
          throw unconfirmedUnlessAnswered(error, SEND_UNCONFIRMED)
        }
        return null
      }),

    confirm: ({ sessionId, toolUseId, allow, denyMessage }) =>
      attempt(store, async (client) => {
        const message = denyMessage?.trim()
        try {
          await client.beta.sessions.events.send(
            sessionId,
            {
              events: [
                {
                  type: 'user.tool_confirmation',
                  tool_use_id: toolUseId,
                  result: allow ? 'allow' : 'deny',
                  // L'API n'accepte `deny_message` que sur un refus.
                  ...(!allow && message ? { deny_message: message } : {})
                }
              ]
            },
            NO_RETRY
          )
        } catch (error) {
          throw unconfirmedUnlessAnswered(error, CONFIRM_UNCONFIRMED)
        }
        return null
      }),

    interrupt: ({ sessionId }) =>
      attempt(store, async (client) => {
        await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] }, NO_RETRY)
        return null
      }),

    create: (input) =>
      attempt(store, async (client) => {
        // Hors du `try` : une saisie invalide n'a rien envoyé, son message ne doit jamais dire « peut exister ».
        const params = toCreateParams(input)
        try {
          const session = await client.beta.sessions.create(params, {
            ...CREATE_OPTIONS,
            signal: AbortSignal.timeout(CREATE_TIMEOUT_MS)
          })
          return { sessionId: session.id }
        } catch (error) {
          // Sans réponse du serveur, la requête a pu aboutir côté API. Une fausse alerte coûte un coup d'œil à la
          // liste, un faux échec une session en double.
          throw unconfirmedUnlessAnswered(error, CREATE_UNCONFIRMED)
        }
      }),

    raiseBudget: ({ sessionId, dollars }) =>
      attempt(store, async (client) => {
        // Le détail part de la session rendue par la mise à jour : une relecture ratée ne dirait pas échec d'un relèvement réussi.
        const updated = await client.beta.sessions.update(sessionId, { budget: budgetOf(dollars) })
        return detailOf(client, updated, idleOf)
      }),

    detail: ({ sessionId }) => attempt(store, (client) => readDetail(client, sessionId, idleOf)),

    testSpend: () =>
      attempt(store, async (client) => {
        const amounts: string[] = []
        let currency = 'USD'
        for await (const session of client.beta.sessions.list({ include_archived: true })) {
          if (session.metadata.purpose !== 'plugin-test') continue
          const cost = session.usage.list_cost
          amounts.push(cost?.amount ?? '0')
          if (cost) currency = cost.currency
        }
        return {
          sessions: amounts.length,
          total: amounts.length > 0 ? { minor: sumMinor(amounts), currency } : null
        }
      })
  }
}
