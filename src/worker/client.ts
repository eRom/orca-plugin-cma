// Client Anthropic du worker : détient la clé (secret du plugin), traduit les erreurs de l'API
// en texte lisible et en code, et lit l'identité du workspace.
import Anthropic from '@anthropic-ai/sdk'
import type { ApiErrorCode, ApiResult, WorkspaceInfo } from '../protocol'
import type { Workspaces } from './workspaces'

export const NO_KEY_MESSAGE = 'Add your Anthropic API key first.'

export const CONFLICT_MESSAGE = 'Changed elsewhere since you opened it.'

/** Levée quand aucune clé n'est enregistrée : `describeError` la rend en `no_key`. */
class NoKeyError extends Error {
  constructor() {
    super(NO_KEY_MESSAGE)
  }
}

export type ClientStore = {
  /** Client construit sur la clé du workspace actif, mis en cache jusqu'à `reset`. */
  get(): Promise<Anthropic>
  /** Oublie le client en cache : la prochaine lecture relit la clé de l'actif. */
  reset(): void
  hasKey(): Promise<boolean>
}

export function createClientStore(activeKey: () => Promise<string | null>): ClientStore {
  let client: Anthropic | null = null
  return {
    async get() {
      if (client) {
        return client
      }
      const key = await activeKey()
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
      return Boolean(await activeKey())
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

/** Le `error.type` du corps d'une erreur de l'API : `{ type: 'error', error: { type, message } }`. */
function errorType(error: InstanceType<typeof Anthropic.APIError>): unknown {
  const body: unknown = error.error
  const inner = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  return typeof inner === 'object' && inner !== null ? (inner as { type?: unknown }).type : undefined
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
  // Un 409 de l'API avec ce type : la mémoire a changé depuis sa lecture (capturé le 22/11, `t7-precondition-probe.log`).
  // Les autres 409 (`memory_path_conflict_error`, chemin déjà pris) gardent le message de l'API.
  if (error instanceof Anthropic.ConflictError && errorType(error) === 'memory_precondition_failed_error') {
    return { message: CONFLICT_MESSAGE, code: 'conflict' }
  }
  if (error instanceof Anthropic.APIError) {
    // Pour un corps standard, `error.message` du SDK porte le statut puis tout le JSON : on garde le seul texte de l'API.
    const apiMessage = error.apiMessage
    const readable = typeof apiMessage === 'string' && apiMessage.trim() !== '' ? apiMessage : error.message
    return { message: `API error ${error.status}: ${readable}`, code: 'other' }
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
 * échec (403, 5xx, réseau) ne fait pas perdre le reste. Les champs décrivent l'actif ; `workspaces`
 * liste tous ceux qui sont associés. Un actif dont l'id était inconnu (migration) l'apprend ici.
 */
export async function workspaceInfo(store: ClientStore, workspaces: Workspaces): Promise<WorkspaceInfo> {
  const index = await workspaces.index()
  // L'id lu pendant cet appel, pour l'entrée active qui ne le connaissait pas.
  let learned: string | null = null
  const rows = (): WorkspaceInfo['workspaces'] =>
    index.entries.map((entry) => {
      const active = entry.localId === index.activeLocalId
      return { ...entry, workspaceId: active ? (entry.workspaceId ?? learned) : entry.workspaceId, active }
    })
  if (!(await store.hasKey())) {
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null, workspaces: rows() }
  }
  try {
    const client = await store.get()
    const call = await client.beta.agents.list({ limit: 1 }).withResponse()
    const organizationName = await client.beta.organization.retrieve().then(
      (organization) => organization.name,
      () => null
    )
    const workspaceId = call.response.headers.get('anthropic-workspace-id')
    const active = index.entries.find((entry) => entry.localId === index.activeLocalId)
    if (active && active.workspaceId === null && workspaceId) {
      await workspaces.noteWorkspaceId(active.localId, workspaceId)
      learned = workspaceId
    }
    return { hasKey: true, keyRejected: false, workspaceId, organizationName, workspaces: rows() }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null, workspaces: rows() }
    }
    throw error
  }
}

/**
 * Lit le workspace d'une clé candidate par l'appel de liste des agents (en-tête
 * `anthropic-workspace-id`). Un 401 se dit `'rejected'` ; toute autre erreur est levée.
 */
export async function probeKey(
  key: string,
  makeClient: (apiKey: string) => Anthropic = (apiKey) => new Anthropic({ apiKey })
): Promise<{ workspaceId: string | null } | 'rejected'> {
  try {
    const call = await makeClient(key).beta.agents.list({ limit: 1 }).withResponse()
    return { workspaceId: call.response.headers.get('anthropic-workspace-id') }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return 'rejected'
    }
    throw error
  }
}
