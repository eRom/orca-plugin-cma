// Client Anthropic du worker : détient la clé (secret du plugin), traduit les erreurs de l'API
// en texte lisible et en code, et lit l'identité du workspace.
import Anthropic from '@anthropic-ai/sdk'
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiErrorCode, ApiResult, WorkspaceInfo } from '../protocol'

export const SECRET_NAME = 'anthropic-api-key'

const NO_KEY_MESSAGE = 'Add your Anthropic API key first.'

/** Levée quand aucune clé n'est enregistrée : `describeError` la rend en `no_key`. */
class NoKeyError extends Error {
  constructor() {
    super(NO_KEY_MESSAGE)
  }
}

export type ClientStore = {
  /** Client construit sur la clé enregistrée, mis en cache jusqu'à `reset`. */
  get(): Promise<Anthropic>
  /** Oublie le client en cache : la prochaine lecture relit le secret. */
  reset(): void
  hasKey(): Promise<boolean>
}

export function createClientStore(secrets: OrcaWorkerApi['secrets']): ClientStore {
  let client: Anthropic | null = null
  return {
    async get() {
      if (client) {
        return client
      }
      const key = await secrets.get(SECRET_NAME)
      if (!key) {
        throw new NoKeyError()
      }
      client = new Anthropic({ apiKey: key })
      return client
    },
    reset() {
      client = null
    },
    async hasKey() {
      return Boolean(await secrets.get(SECRET_NAME))
    }
  }
}

/**
 * Les refus de budget d'une `BadRequestError`. Le corps réel de `budget_create_only` (capturé le
 * 22/11) ne porte aucun code : seulement un message, d'où `pattern`. Les deux autres refus n'ont
 * jamais été capturés : on cherche leur nom dans tout le corps (`code`), ou les messages documentés
 * (https://platform.claude.com/docs/en/managed-agents/budgets) par `pattern`.
 */
const BUDGET_ERRORS: {
  code: 'model_not_budgetable' | 'budget_not_raised' | 'budget_create_only'
  message: string
  pattern?: RegExp
}[] = [
  {
    code: 'model_not_budgetable',
    message: 'A model of this agent has no public price, so the session cannot have a budget.',
    pattern: /no list price is available for the model/i
  },
  {
    code: 'budget_not_raised',
    message: 'The new budget must be above what the session already cost.',
    pattern: /must be greater than the session.s consumed list cost/i
  },
  {
    code: 'budget_create_only',
    message: 'A budget can only be set when the session is created.',
    pattern: /can only be attached when a session is created/
  }
]

function budgetError(error: InstanceType<typeof Anthropic.BadRequestError>): { message: string; code: ApiErrorCode } | null {
  const body = JSON.stringify(error.error ?? null)
  const found = BUDGET_ERRORS.find((entry) => entry.pattern?.test(body) || body.includes(entry.code))
  return found ? { message: found.message, code: found.code } : null
}

export function describeError(error: unknown): { message: string; code: ApiErrorCode } {
  if (error instanceof NoKeyError) {
    return { message: NO_KEY_MESSAGE, code: 'no_key' }
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: 'The API key was rejected (401).', code: 'unauthorized' }
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return { message: 'This key is not allowed to do that (403).', code: 'other' }
  }
  if (error instanceof Anthropic.NotFoundError) {
    return { message: 'Not found (404).', code: 'other' }
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: 'Rate limited (429). Try again shortly.', code: 'other' }
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: 'Could not reach api.anthropic.com.', code: 'other' }
  }
  if (error instanceof Anthropic.BadRequestError) {
    const budget = budgetError(error)
    if (budget) {
      return budget
    }
  }
  if (error instanceof Anthropic.APIError) {
    return { message: `API error ${error.status}: ${error.message}`, code: 'other' }
  }
  return { message: error instanceof Error ? error.message : String(error), code: 'other' }
}

/** Une erreur que réessayer ne corrigera pas : une boucle de flux s'arrête dessus. */
export function isFatal(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError ||
    error instanceof Anthropic.BadRequestError
  )
}

/** Un appel à l'API : l'erreur revient en `ApiResult`, jamais en exception. */
export async function attempt<T>(
  store: ClientStore,
  run: (client: Anthropic) => Promise<T>
): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await run(await store.get()) }
  } catch (error) {
    return failure(error)
  }
}

/** Le `ApiResult` d'échec d'une erreur de l'API. */
export function failure(error: unknown): { ok: false; error: string; code: ApiErrorCode } {
  const { message, code } = describeError(error)
  return { ok: false, error: message, code }
}

/**
 * Identité du workspace de la clé. Seul l'appel de liste des agents décide : un 401 est l'état
 * « clé refusée », toute autre erreur est levée à l'appelant. L'id vient de l'en-tête
 * `anthropic-workspace-id` de cet appel ; le nom de l'organisation est un complément, et son
 * échec (403, 5xx, réseau) ne fait pas perdre le reste.
 */
export async function workspaceInfo(store: ClientStore): Promise<WorkspaceInfo> {
  if (!(await store.hasKey())) {
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null }
  }
  try {
    const client = await store.get()
    const call = await client.beta.agents.list({ limit: 1 }).withResponse()
    const organizationName = await client.beta.organization.retrieve().then(
      (organization) => organization.name,
      () => null
    )
    return {
      hasKey: true,
      keyRejected: false,
      workspaceId: call.response.headers.get('anthropic-workspace-id'),
      organizationName
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null }
    }
    throw error
  }
}

/**
 * Enregistre une clé et ne la garde que si l'API l'accepte. Tout échec (401 ou autre) supprime
 * le secret avant de rendre l'erreur : le panneau ne reste jamais bloqué sur une clé inutilisable.
 */
export async function setKey(
  secrets: OrcaWorkerApi['secrets'],
  store: ClientStore,
  key: string
): Promise<ApiResult<WorkspaceInfo>> {
  await secrets.set(SECRET_NAME, key.trim())
  store.reset()
  let result: ApiResult<WorkspaceInfo>
  try {
    const info = await workspaceInfo(store)
    result = info.keyRejected
      ? { ok: false, error: 'The API key was rejected (401).', code: 'unauthorized' }
      : { ok: true, value: info }
  } catch (error) {
    result = failure(error)
  }
  if (!result.ok) {
    await secrets.delete(SECRET_NAME)
    store.reset()
  }
  return result
}
