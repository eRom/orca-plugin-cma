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
 * Identité du workspace de la clé : l'id vient de l'en-tête `anthropic-workspace-id` d'un appel
 * de liste, le nom de l'organisation d'un appel dédié. Un 401 n'est pas une erreur ici, c'est
 * l'état « clé refusée » ; toute autre erreur est levée à l'appelant.
 */
export async function workspaceInfo(store: ClientStore): Promise<WorkspaceInfo> {
  if (!(await store.hasKey())) {
    return { hasKey: false, keyRejected: false, workspaceId: null, organizationName: null }
  }
  try {
    const client = await store.get()
    const call = await client.beta.agents.list({ limit: 1 }).withResponse()
    const organization = await client.beta.organization.retrieve()
    return {
      hasKey: true,
      keyRejected: false,
      workspaceId: call.response.headers.get('anthropic-workspace-id'),
      organizationName: organization.name
    }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { hasKey: true, keyRejected: true, workspaceId: null, organizationName: null }
    }
    throw error
  }
}
