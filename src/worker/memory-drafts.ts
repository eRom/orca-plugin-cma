// Les mémoires dans l'éditeur : un brouillon par mémoire (`memories/<banque>--<id>/<chemin>`), lu à
// l'état actuel, envoyé avec l'empreinte lue comme garde (un contenu changé ailleurs devient `conflict`),
// puis réécrit avec ce que l'API a gardé. Le renommage d'une mémoire passe ici aussi : il partage la même
// garde et refuse quand un brouillon non appliqué existe.
import Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsMemory } from '@anthropic-ai/sdk/resources/beta/memory-stores/memories'
import { createHash } from 'node:crypto'
import type { ApiResult, Committed, DraftRef, MemoryRenameInput, ResourceRef, Saved } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath } from '../shared/memory-path'
import { attempt, type ClientStore } from './client'
import { diffDocuments } from './diff'
import { sameRef, slugify, type DraftAdapter, type DraftBase, type Drafts } from './drafts'

type MemoryRef = Extract<DraftRef, { kind: 'memory' }>

const OPEN_DRAFT_MESSAGE = 'Apply or discard the open draft of this memory first.'

/** Le fichier d'une mémoire dans le dossier de brouillons : `memories/<slug de la banque>--<id>/<chemin>`. */
export function memoryFile(storeName: string, storeId: string, path: string): string {
  return `memories/${slugify(storeName)}--${storeId}${path}`
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** L'empreinte que l'écriture vérifie : celle de la lecture, ou rien (création, ou brouillon sans empreinte). */
const expectedSha = (base: DraftBase): string | null => (base !== null && 'sha256' in base ? base.sha256 : null)

export function createMemoryAdapter(
  store: ClientStore,
  drafts: () => Drafts,
  log: (message: string) => void = () => {}
): DraftAdapter<MemoryRef> {
  /** La mémoire en vue complète : sans `view: 'full'`, l'API rend `content: null`. */
  async function readFull(memoryStoreId: string, memoryId: string): Promise<{ content: string; sha256: string }> {
    const client = await store.get()
    const memory = await client.beta.memoryStores.memories.retrieve(memoryId, { memory_store_id: memoryStoreId, view: 'full' })
    // Un contenu absent ne devient jamais un brouillon vide : Romain croirait la mémoire vide et l'écraserait.
    if (typeof memory.content !== 'string') {
      throw new Error('The API returned no content for this memory.')
    }
    return { content: memory.content, sha256: memory.content_sha256 }
  }

  /**
   * L'id de la mémoire d'un brouillon et son contenu vivant. Un id que le registre seul a fourni (la référence n'en
   * porte pas : « New memory » rouverte, ou la création d'un envoi précédent) et que l'API ne connaît plus (404)
   * est celui d'une mémoire supprimée ailleurs : le brouillon est alors celui d'une mémoire à créer. Un id que la
   * référence porte elle-même et que l'API refuse reste une erreur : on ne ressuscite pas une mémoire sous un autre id.
   */
  async function resolveLive(ref: MemoryRef): Promise<{ memoryId: string | null; content: string; sha256: string | null; recordedGone: boolean }> {
    const recorded = ref.memoryId === null ? ((await registered(ref))?.ref.memoryId ?? null) : null
    const memoryId = ref.memoryId ?? recorded
    if (memoryId === null) {
      return { memoryId: null, content: '', sha256: null, recordedGone: false }
    }
    try {
      const live = await readFull(ref.memoryStoreId, memoryId)
      return { memoryId, content: live.content, sha256: live.sha256, recordedGone: false }
    } catch (error) {
      if (recorded !== null && error instanceof Anthropic.NotFoundError) {
        return { memoryId: null, content: '', sha256: null, recordedGone: true }
      }
      throw error
    }
  }

  /**
   * Le brouillon déjà enregistré pour cette référence, retrouvé par l'id de la mémoire (son chemin a pu
   * changer), ou par le chemin d'une création : il porte alors l'id de la mémoire que l'envoi a créée.
   */
  async function registered(ref: MemoryRef): Promise<{ ref: MemoryRef; file: string } | null> {
    const [match] = await drafts().find((known) => sameRef(known, ref))
    return match && match.ref.kind === 'memory' ? { ref: match.ref, file: match.file } : null
  }

  /** Le dossier de cette banque déjà utilisé par un brouillon, quel que soit son slug : il se reconnaît à `--<storeId>`. */
  async function folderOf(memoryStoreId: string): Promise<string | null> {
    const suffix = `--${memoryStoreId}`
    for (const known of await drafts().find((candidate) => candidate.kind === 'memory' && candidate.memoryStoreId === memoryStoreId)) {
      const [root, directory] = known.file.split(/[\\/]/)
      if (root === 'memories' && directory !== undefined && directory.endsWith(suffix)) {
        return `memories/${directory}`
      }
    }
    return null
  }

  /** L'envoi, une fois le récapitulatif confirmé. Un conflit de contenu vient de `describeError` (409 `memory_precondition_failed_error`). */
  function send(ref: MemoryRef, memoryId: string | null, text: string, base: DraftBase, force: boolean): Promise<ApiResult<Committed>> {
    return attempt(store, async (client) => {
      const memories = client.beta.memoryStores.memories
      const expected = expectedSha(base)
      const response =
        memoryId === null
          ? await memories.create(ref.memoryStoreId, { path: ref.path, content: text, view: 'full' })
          : await memories.update(memoryId, {
              memory_store_id: ref.memoryStoreId,
              content: text,
              ...(!force && expected !== null && { precondition: { type: 'content_sha256' as const, content_sha256: expected } }),
              view: 'full'
            })
      await rewriteAfterSend(ref, response, text)
      return { label: 'Applied' }
    })
  }

  /**
   * Le fichier reprend ce que l'API a gardé. L'envoi étant fait, rien ici ne le fait échouer : un souci
   * se journalise et le brouillon reste tel quel (non appliqué).
   */
  async function rewriteAfterSend(ref: MemoryRef, response: BetaManagedAgentsMemory, text: string): Promise<void> {
    try {
      let written = { content: text, sha256: response.content_sha256 }
      if (typeof response.content === 'string') {
        written = { content: response.content, sha256: response.content_sha256 }
      } else if (sha256(text) !== response.content_sha256) {
        // Le serveur a gardé autre chose que le texte envoyé et ne le dit pas : on le relit.
        written = await readFull(ref.memoryStoreId, response.id)
      }
      const created: MemoryRef = { kind: 'memory', memoryStoreId: ref.memoryStoreId, memoryId: response.id, path: response.path }
      await drafts().rewrite(created, written.content, { sha256: written.sha256 }, text)
    } catch (error) {
      log(`memory draft kept as sent, not rewritten after a successful send: ${messageOf(error)}`)
    }
  }

  return {
    check: (ref) => (isSafeMemoryPath(ref.path) ? null : INVALID_MEMORY_PATH),

    async file(ref) {
      const known = await registered(ref)
      if (known) {
        return known.file
      }
      const folder = await folderOf(ref.memoryStoreId)
      if (folder !== null) {
        return `${folder}${ref.path}`
      }
      const client = await store.get()
      const { name } = await client.beta.memoryStores.retrieve(ref.memoryStoreId)
      return memoryFile(name, ref.memoryStoreId, ref.path)
    },

    async readLive(ref) {
      const live = await resolveLive(ref)
      // Une nouvelle mémoire part d'un fichier vide.
      if (live.sha256 === null) {
        return live.recordedGone ? { text: '', base: null, recordedGone: true } : { text: '', base: null }
      }
      return { text: live.content, base: { sha256: live.sha256 } }
    },

    async prepare(ref, text, base, stage) {
      const live = await resolveLive(ref)
      // Une mémoire existante n'est jamais écrite sans la garde de ce que le brouillon a lu : sans empreinte
      // enregistrée (registre refait, entrée sans base), l'envoi écraserait un contenu que personne n'a vu.
      if (live.memoryId !== null && expectedSha(base) === null) {
        return { ok: false, code: 'other', error: 'The draft file is gone: open it again.' }
      }
      // Un brouillon identique au contenu en ligne n'a rien à envoyer (le contenu a changé ailleurs, puis le fichier a suivi).
      if (live.memoryId !== null && text === live.content) {
        return { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: save the file first (⌘S).' }
      }
      const changes = diffDocuments({ content: live.content }, { content: text })
      return { ok: true, value: stage((force) => send(ref, live.memoryId, text, base, force), changes, live.memoryId === null) }
    }
  }
}

/**
 * Le renommage d'une mémoire, gardé par l'empreinte lue par le panneau. Il refuse tant qu'un brouillon non
 * appliqué existe pour cette mémoire : renommer sous un brouillon en cours le ferait écrire à côté.
 */
export function createMemoryRename(
  store: ClientStore,
  drafts: () => Drafts | null,
  log: (message: string) => void = () => {}
): (input: MemoryRenameInput) => Promise<ApiResult<Saved>> {
  return async (input) => {
    if (!isSafeMemoryPath(input.path)) {
      return { ok: false, code: 'invalid', error: INVALID_MEMORY_PATH }
    }
    // Sans projet de brouillons retenu, il n'y a aucun brouillon à protéger ni à libérer : le renommage seul se fait.
    const current = drafts()
    const open = current
      ? await current.find(
          (ref) => ref.kind === 'memory' && ref.memoryStoreId === input.memoryStoreId && ref.memoryId === input.memoryId
        )
      : []
    if (open.some((draft) => draft.unapplied)) {
      return { ok: false, code: 'invalid', error: OPEN_DRAFT_MESSAGE }
    }
    const renamed = await attempt(store, async (client) => {
      const updated = await client.beta.memoryStores.memories.update(input.memoryId, {
        memory_store_id: input.memoryStoreId,
        path: input.path,
        precondition: { type: 'content_sha256', content_sha256: input.baseSha256 }
      })
      return { id: updated.id, updatedAt: updated.updated_at }
    })
    if (renamed.ok && current) {
      // Le brouillon propre garde l'ancien chemin : on l'oublie, pour que ce chemin serve à une autre mémoire.
      await releaseDrafts(() => current, (ref) => ref.kind === 'memory' && ref.memoryStoreId === input.memoryStoreId && ref.memoryId === input.memoryId, log)
    }
    return renamed
  }
}

/** Le brouillon d'une mémoire supprimée est celui d'une nouvelle mémoire au même chemin. */
const asNewMemory = (ref: DraftRef): DraftRef => (ref.kind === 'memory' ? { ...ref, memoryId: null } : ref)

/**
 * Oublie les brouillons propres que `match` désigne. Le renommage ou la suppression étant faits, un échec ici se
 * journalise seulement. `becomes` : ce que devient un brouillon non appliqué (il reste, sous cette référence).
 */
async function releaseDrafts(
  drafts: () => Drafts,
  match: (ref: DraftRef) => boolean,
  log: (message: string) => void,
  becomes?: (ref: DraftRef) => DraftRef
): Promise<void> {
  try {
    const { kept } = await drafts().release(match, becomes)
    for (const file of kept) {
      log(`memory draft kept (unapplied edits): ${file}`)
    }
  } catch (error) {
    log(`memory drafts not released: ${messageOf(error)}`)
  }
}

/**
 * Après la suppression d'une mémoire, ou d'une banque (toutes ses mémoires) : leurs brouillons propres sont
 * oubliés. Tout autre type de ressource est sans effet.
 */
export async function releaseDeletedDrafts(ref: ResourceRef, drafts: () => Drafts, log: (message: string) => void = () => {}): Promise<void> {
  if (ref.kind === 'memory') {
    // Un brouillon non appliqué reste : sa mémoire n'existe plus, il devient une nouvelle mémoire au même chemin.
    await releaseDrafts(drafts, (known) => known.kind === 'memory' && known.memoryStoreId === ref.memoryStoreId && known.memoryId === ref.id, log, asNewMemory)
  } else if (ref.kind === 'memory_store') {
    await releaseDrafts(drafts, (known) => known.kind === 'memory' && known.memoryStoreId === ref.id, log)
  }
}
