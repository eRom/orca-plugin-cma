// Les workspaces Anthropic associés : un index sans clé (noms, identifiants, actif) et une clé par secret.
// Lister ne lit aucune clé ; retirer n'efface qu'une clé. Le plugin n'a que `secrets:own`, d'où l'index
// rangé dans un secret à part.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ApiResult } from '../protocol'
import { failure } from './client'

export const INDEX_SECRET = 'workspaces-index'
/** L'ancien secret unique, migré en entrée « Default » au premier démarrage. */
export const LEGACY_SECRET = 'anthropic-api-key'
export const keySecret = (localId: string): string => `anthropic-api-key:${localId}`

export type WorkspaceIndex = {
  entries: { localId: string; name: string; workspaceId: string | null }[]
  activeLocalId: string | null
  /** Le `localId` de l'entrée issue de la migration (les brouillons d'avant les workspaces lui reviennent). */
  migratedLocalId: string | null
}

export type Workspaces = {
  index(): Promise<WorkspaceIndex>
  /** La clé de l'actif, `null` quand il n'y a pas d'actif ou que son secret manque. */
  activeKey(): Promise<string | null>
  migrate(): Promise<void>
  add(name: string, key: string): Promise<ApiResult<void>>
  rename(localId: string, name: string): Promise<ApiResult<void>>
  replaceKey(localId: string, key: string): Promise<ApiResult<void>>
  remove(localId: string): Promise<ApiResult<{ activeChanged: boolean }>>
  activate(localId: string): Promise<ApiResult<{ activeChanged: boolean }>>
  nameOf(localId: string): Promise<string | null>
  /** Note le `workspaceId` d'une entrée qui ne le connaissait pas encore. */
  noteWorkspaceId(localId: string, workspaceId: string): Promise<void>
}

export type WorkspacesDeps = {
  secrets: OrcaWorkerApi['secrets']
  /** Lit le workspace d'une clé ; `'rejected'` pour un 401, une exception pour tout autre échec. */
  probe: (key: string) => Promise<{ workspaceId: string | null } | 'rejected'>
  newId: () => string
  log: (message: string) => void
}

const EMPTY_INDEX: WorkspaceIndex = { entries: [], activeLocalId: null, migratedLocalId: null }

const NAME_REQUIRED = 'Name is required.'
const UNKNOWN_WORKSPACE = 'This workspace is not in the list.'

const refuse = (code: 'invalid' | 'other', error: string): { ok: false; code: 'invalid' | 'other'; error: string } => ({
  ok: false,
  code,
  error
})

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

/** Lit l'index sérialisé ; `null` quand sa forme n'est pas celle attendue. */
function parseIndex(raw: string): WorkspaceIndex | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const { entries, activeLocalId, migratedLocalId = null } = data as Record<string, unknown>
  if (!Array.isArray(entries) || !isNullableString(activeLocalId) || !isNullableString(migratedLocalId)) {
    return null
  }
  const parsed: WorkspaceIndex['entries'] = []
  for (const entry of entries) {
    const { localId, name, workspaceId } = (entry ?? {}) as Record<string, unknown>
    if (typeof localId !== 'string' || typeof name !== 'string' || !isNullableString(workspaceId)) {
      return null
    }
    parsed.push({ localId, name, workspaceId })
  }
  // Un actif qui n'existe plus dans la liste retombe sur la première entrée.
  const active = parsed.some((entry) => entry.localId === activeLocalId) ? activeLocalId : (parsed[0]?.localId ?? null)
  return { entries: parsed, activeLocalId: active, migratedLocalId }
}

export function createWorkspaces(deps: WorkspacesDeps): Workspaces {
  const { secrets, probe, newId, log } = deps

  // Les écritures passent une à une : une lecture-modification-écriture de l'index ne doit pas en écraser une autre.
  let queue: Promise<unknown> = Promise.resolve()
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run)
    queue = result.catch(() => undefined)
    return result
  }

  async function readIndex(): Promise<WorkspaceIndex> {
    const raw = await secrets.get(INDEX_SECRET)
    if (raw === null || raw === undefined) {
      return EMPTY_INDEX
    }
    const parsed = parseIndex(raw)
    if (!parsed) {
      log('workspaces index is unreadable: treated as empty, nothing deleted')
      return EMPTY_INDEX
    }
    return parsed
  }

  const writeIndex = (index: WorkspaceIndex): Promise<void> => secrets.set(INDEX_SECRET, JSON.stringify(index))

  /** Le workspace de la clé, ou le refus à rendre tel quel. */
  async function identify(key: string): Promise<{ workspaceId: string } | ReturnType<typeof failure>> {
    let probed: Awaited<ReturnType<WorkspacesDeps['probe']>>
    try {
      probed = await probe(key)
    } catch (error) {
      return failure(error)
    }
    if (probed === 'rejected') {
      return { ok: false, code: 'unauthorized', error: 'The API key was rejected (401).' }
    }
    if (!probed.workspaceId) {
      return refuse('other', 'Could not read the workspace of this key.')
    }
    return { workspaceId: probed.workspaceId }
  }

  const holderOf = (index: WorkspaceIndex, workspaceId: string, except?: string) =>
    index.entries.find((entry) => entry.workspaceId === workspaceId && entry.localId !== except)

  return {
    index: readIndex,

    async activeKey() {
      const { activeLocalId } = await readIndex()
      if (!activeLocalId) {
        return null
      }
      return (await secrets.get(keySecret(activeLocalId))) ?? null
    },

    migrate() {
      return serialized(async () => {
        if ((await secrets.get(INDEX_SECRET)) != null) {
          return
        }
        const legacy = await secrets.get(LEGACY_SECRET)
        if (!legacy) {
          return
        }
        // Une lecture qui échoue ne bloque pas la migration : le `workspaceId` se relit au prochain appel réussi.
        let workspaceId: string | null = null
        try {
          const probed = await probe(legacy)
          workspaceId = probed === 'rejected' ? null : probed.workspaceId
        } catch (error) {
          log(`migration could not read the workspace id: ${failure(error).error}`)
        }
        const localId = newId()
        await secrets.set(keySecret(localId), legacy)
        await writeIndex({
          entries: [{ localId, name: 'Default', workspaceId }],
          activeLocalId: localId,
          migratedLocalId: localId
        })
        await secrets.delete(LEGACY_SECRET)
        log('migrated the legacy API key to the workspace Default')
      })
    },

    add(name, key) {
      return serialized(async (): Promise<ApiResult<void>> => {
        const cleanName = name.trim()
        const cleanKey = key.trim()
        if (!cleanName) {
          return refuse('invalid', NAME_REQUIRED)
        }
        if (!cleanKey) {
          return refuse('invalid', 'API key is required.')
        }
        const identity = await identify(cleanKey)
        if (!('workspaceId' in identity)) {
          return identity
        }
        const index = await readIndex()
        const holder = holderOf(index, identity.workspaceId)
        if (holder) {
          return refuse('other', `This key belongs to ${holder.name}, already added.`)
        }
        const localId = newId()
        // La clé d'abord : une entrée sans clé est un état visible, une clé sans entrée est inerte.
        await secrets.set(keySecret(localId), cleanKey)
        await writeIndex({
          ...index,
          entries: [...index.entries, { localId, name: cleanName, workspaceId: identity.workspaceId }],
          activeLocalId: index.activeLocalId ?? localId
        })
        return { ok: true, value: undefined }
      })
    },

    rename(localId, name) {
      return serialized(async (): Promise<ApiResult<void>> => {
        const cleanName = name.trim()
        if (!cleanName) {
          return refuse('invalid', NAME_REQUIRED)
        }
        const index = await readIndex()
        if (!index.entries.some((entry) => entry.localId === localId)) {
          return refuse('other', UNKNOWN_WORKSPACE)
        }
        await writeIndex({
          ...index,
          entries: index.entries.map((entry) => (entry.localId === localId ? { ...entry, name: cleanName } : entry))
        })
        return { ok: true, value: undefined }
      })
    },

    replaceKey(localId, key) {
      return serialized(async (): Promise<ApiResult<void>> => {
        const cleanKey = key.trim()
        if (!cleanKey) {
          return refuse('invalid', 'API key is required.')
        }
        const index = await readIndex()
        const entry = index.entries.find((candidate) => candidate.localId === localId)
        if (!entry) {
          return refuse('other', UNKNOWN_WORKSPACE)
        }
        const identity = await identify(cleanKey)
        if (!('workspaceId' in identity)) {
          return identity
        }
        if (entry.workspaceId !== null && entry.workspaceId !== identity.workspaceId) {
          return refuse('other', `This key is for ${identity.workspaceId}, not ${entry.workspaceId}.`)
        }
        const holder = holderOf(index, identity.workspaceId, localId)
        if (holder) {
          return refuse('other', `This key belongs to ${holder.name}, already added.`)
        }
        await secrets.set(keySecret(localId), cleanKey)
        // Une entrée migrée sans identifiant l'apprend ici.
        if (entry.workspaceId === null) {
          await writeIndex({
            ...index,
            entries: index.entries.map((candidate) =>
              candidate.localId === localId ? { ...candidate, workspaceId: identity.workspaceId } : candidate
            )
          })
        }
        return { ok: true, value: undefined }
      })
    },

    remove(localId) {
      return serialized(async (): Promise<ApiResult<{ activeChanged: boolean }>> => {
        const index = await readIndex()
        if (!index.entries.some((entry) => entry.localId === localId)) {
          return refuse('other', UNKNOWN_WORKSPACE)
        }
        const entries = index.entries.filter((entry) => entry.localId !== localId)
        const activeChanged = index.activeLocalId === localId
        // L'index d'abord : si l'effacement de la clé échoue, il reste un secret inerte, jamais une entrée sans clé.
        await writeIndex({
          ...index,
          entries,
          activeLocalId: activeChanged ? (entries[0]?.localId ?? null) : index.activeLocalId
        })
        await secrets.delete(keySecret(localId))
        return { ok: true, value: { activeChanged } }
      })
    },

    activate(localId) {
      return serialized(async (): Promise<ApiResult<{ activeChanged: boolean }>> => {
        const index = await readIndex()
        if (!index.entries.some((entry) => entry.localId === localId)) {
          return refuse('other', UNKNOWN_WORKSPACE)
        }
        if (index.activeLocalId === localId) {
          return { ok: true, value: { activeChanged: false } }
        }
        await writeIndex({ ...index, activeLocalId: localId })
        return { ok: true, value: { activeChanged: true } }
      })
    },

    async nameOf(localId) {
      const index = await readIndex()
      return index.entries.find((entry) => entry.localId === localId)?.name ?? null
    },

    noteWorkspaceId(localId, workspaceId) {
      return serialized(async () => {
        const index = await readIndex()
        const entry = index.entries.find((candidate) => candidate.localId === localId)
        if (!entry || entry.workspaceId !== null) {
          return
        }
        await writeIndex({
          ...index,
          entries: index.entries.map((candidate) => (candidate.localId === localId ? { ...candidate, workspaceId } : candidate))
        })
      })
    }
  }
}
