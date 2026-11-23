// Envoi de fichiers locaux comme mémoires : le worker choisit le fichier (boîte de dialogue du système),
// le lit, et prépare UNE écriture en attente pour toutes les lignes. Le contenu ne quitte jamais le worker :
// le panneau ne voit que des chemins, et ni journal ni message d'erreur ne porte un contenu ou un chemin absolu.
import type Anthropic from '@anthropic-ai/sdk'
import type { BetaManagedAgentsMemory, BetaManagedAgentsMemoryListItem } from '@anthropic-ai/sdk/resources/beta/memory-stores/memories'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { ApiResult, Committed, FieldChange, PickedFile, PreparedWrite, UploadItem } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath } from '../shared/memory-path'
import { attempt, describeError, type ClientStore } from './client'
import { abbreviate, summarizeLines } from './diff'
import type { PendingWrites } from './pending-writes'

const PICK_PROMPT = 'Choose a file to upload as a memory'
const NOT_MACOS_MESSAGE = 'File picking works on macOS only.'
const PICK_FAILED_MESSAGE = 'Could not open the file picker.'
const NOT_TEXT_MESSAGE = 'This file is not text: memories hold UTF-8 text.'
const TAKEN_PATH_MESSAGE = 'A memory already has this path.'

export type FilePickerDeps = {
  platform: string
  /** Lance `osascript` avec ces arguments et rend sa sortie standard ; rejette quand il sort en erreur. */
  run: (args: string[]) => Promise<string>
}

const execFileAsync = promisify(execFile)

/** L'exécution réelle : `osascript`. Les tests injectent la leur, aucun ne ouvre de vraie boîte de dialogue. */
export const runOsascript = async (args: string[]): Promise<string> => (await execFileAsync('osascript', args)).stdout

/** Le choix d'un fichier. macOS seulement ; annuler la boîte (erreur -128 d'`osascript`) rend `null`. */
export function createFilePicker(deps: FilePickerDeps): () => Promise<ApiResult<PickedFile | null>> {
  return async () => {
    if (deps.platform !== 'darwin') {
      return { ok: false, code: 'other', error: NOT_MACOS_MESSAGE }
    }
    try {
      const output = await deps.run(['-e', `POSIX path of (choose file with prompt "${PICK_PROMPT}")`])
      const file = output.replace(/\r?\n$/, '')
      return { ok: true, value: file === '' ? null : { file, name: basename(file) } }
    } catch (error) {
      if (error instanceof Error && error.message.includes('-128')) {
        return { ok: true, value: null }
      }
      return { ok: false, code: 'other', error: PICK_FAILED_MESSAGE }
    }
  }
}

/** Une ligne dont le fichier est lu et reconnu comme du texte UTF-8. */
type Line = { path: string; memoryId: string | null; content: string }

const invalid = (error: string): { ok: false; code: 'invalid'; error: string } => ({ ok: false, code: 'invalid', error })

// `ignoreBOM: true` garde un éventuel BOM dans le texte : le contenu envoyé égale le fichier octet pour octet.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Le texte d'un fichier, ou le message du refus (jamais le chemin absolu : le nom de base seul). */
async function readText(file: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch {
    return { ok: false, error: `Could not read ${basename(file)}.` }
  }
  if (bytes.includes(0)) {
    return { ok: false, error: NOT_TEXT_MESSAGE }
  }
  try {
    return { ok: true, content: utf8.decode(bytes) }
  } catch {
    return { ok: false, error: NOT_TEXT_MESSAGE }
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = []
  for await (const item of items) all.push(item)
  return all
}

const isMemory = (item: BetaManagedAgentsMemoryListItem): item is BetaManagedAgentsMemory => item.type === 'memory'

/**
 * Deux chemins se recouvrent quand ils sont égaux ou que l'un est l'ancêtre de l'autre (`/notes` et
 * `/notes/todo.md`) : l'API refuse alors le second (409 `memory_path_conflict_error`). Insensible à la casse.
 */
function overlaps(first: string, second: string): boolean {
  const p = first.toLowerCase()
  const q = second.toLowerCase()
  return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`)
}

const memoriesCount =(count: number): string => (count === 1 ? 'Uploaded 1 memory' : `Uploaded ${count} memories`)

/** Un remplacement retenu : la mémoire en ligne, dont l'empreinte devient la précondition. */
type Send = { line: Line; memoryId: string | null; precondition: string | null }

/**
 * Prépare l'envoi des lignes. Validation locale d'abord (chemin, doublon, lecture du fichier), dans l'ordre des
 * lignes, sans aucune requête ; puis la banque est relue (chemin pris) et chaque mémoire à remplacer l'est aussi.
 */
export function createMemoryUploads(
  store: ClientStore,
  pending: PendingWrites,
  log: (message: string) => void = () => {}
): (input: { memoryStoreId: string; items: UploadItem[] }) => Promise<ApiResult<PreparedWrite>> {
  return async ({ memoryStoreId, items }) => {
    if (items.length === 0) {
      return invalid('Nothing to upload.')
    }
    const seen: string[] = []
    for (const { path } of items) {
      if (!isSafeMemoryPath(path)) {
        return invalid(INVALID_MEMORY_PATH)
      }
      if (seen.some((earlier) => overlaps(earlier, path))) {
        return invalid(TAKEN_PATH_MESSAGE)
      }
      seen.push(path)
    }
    const lines: Line[] = []
    for (const { path, file, memoryId } of items) {
      const text = await readText(file)
      if (!text.ok) {
        return invalid(text.error)
      }
      lines.push({ path, memoryId, content: text.content })
    }

    const prepared = await attempt(store, async (client): Promise<{ refused: string } | { sends: Send[]; changes: FieldChange[] }> => {
      const listed = (await collect(client.beta.memoryStores.memories.list(memoryStoreId))).filter(isMemory)
      for (const line of lines) {
        const taken = listed.some((memory) => memory.id !== line.memoryId && overlaps(memory.path, line.path))
        if (taken) {
          return { refused: TAKEN_PATH_MESSAGE }
        }
      }
      const sends: Send[] = []
      const changes: FieldChange[] = []
      for (const line of lines) {
        if (line.memoryId === null) {
          sends.push({ line, memoryId: null, precondition: null })
          changes.push({ path: line.path, before: null, after: abbreviate(line.content), lines: summarizeLines('', line.content) })
          continue
        }
        const live = await client.beta.memoryStores.memories.retrieve(line.memoryId, { memory_store_id: memoryStoreId, view: 'full' })
        // Un contenu absent ne devient jamais un « avant » vide : le récapitulatif mentirait.
        if (typeof live.content !== 'string') {
          throw new Error('The API returned no content for this memory.')
        }
        if (live.content === line.content) {
          continue
        }
        sends.push({ line, memoryId: line.memoryId, precondition: live.content_sha256 })
        changes.push({ path: line.path, before: abbreviate(live.content), after: abbreviate(line.content), lines: summarizeLines(live.content, line.content) })
      }
      return { sends, changes }
    })
    if (!prepared.ok) {
      return prepared
    }
    if ('refused' in prepared.value) {
      return invalid(prepared.value.refused)
    }
    const { sends, changes } = prepared.value
    if (sends.length === 0) {
      return { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: these files match the memories.' }
    }
    const creates = sends.some((send) => send.memoryId === null)
    return { ok: true, value: pending.stage(sequentialSend(store, memoryStoreId, sends, log), changes, creates) }
  }
}

/**
 * L'envoi, ligne par ligne dans l'ordre. La fermeture retient les lignes déjà passées : un réessai après un échec,
 * ou « Apply anyway », saute celles-là au lieu de recréer une mémoire. Un brouillon ouvert pour une mémoire
 * remplacée n'est pas touché : son cycle le dira périmé par sa précondition.
 */
function sequentialSend(
  store: ClientStore,
  memoryStoreId: string,
  sends: Send[],
  log: (message: string) => void
): (force: boolean) => Promise<ApiResult<Committed>> {
  const done = new Set<number>()
  return async (force) => {
    try {
      const client: Anthropic = await store.get()
      for (const [index, { line, memoryId, precondition }] of sends.entries()) {
        if (done.has(index)) {
          continue
        }
        if (memoryId === null) {
          await client.beta.memoryStores.memories.create(memoryStoreId, { path: line.path, content: line.content, view: 'full' })
        } else {
          await client.beta.memoryStores.memories.update(memoryId, {
            memory_store_id: memoryStoreId,
            content: line.content,
            ...(!force && precondition !== null && { precondition: { type: 'content_sha256' as const, content_sha256: precondition } }),
            view: 'full'
          })
        }
        done.add(index)
      }
      return { ok: true, value: { label: memoriesCount(sends.length) } }
    } catch (error) {
      const { message, code } = describeError(error)
      log(`memory upload stopped after ${done.size} of ${sends.length} lines: ${code}`)
      return { ok: false, code, error: done.size > 0 ? `Uploaded ${done.size} of ${sends.length}. ${message}` : message }
    }
  }
}

