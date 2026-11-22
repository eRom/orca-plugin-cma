// Le dossier de brouillons : Romain édite un agent ou une mémoire comme un fichier, dans un onglet
// d'éditeur d'Orca. Le worker écrit le fichier, garde dans un registre ce qu'il y a écrit (empreinte,
// base de lecture, workspace de retour), et sait donc dire si le fichier a été modifié depuis.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ApiErrorCode, ApiResult, DraftInfo, DraftRef, DraftsStatus, PreparedWrite } from '../protocol'
import { failure } from './client'
import type { EditorHost } from './editor-host'
import type { PendingWrites } from './pending-writes'

export const DRAFTS_FOLDER = join(homedir(), '.config', 'agent-claude-managed', 'managed-agents')
export const REGISTRY_FILE = '.orca-drafts.json'

/** Nom de fichier lisible tiré d'un nom d'objet ; sert aux adaptateurs (agents, mémoires). */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'item' : slug
}

/** Ce que l'écriture devra vérifier : la version de l'agent, l'empreinte de la mémoire, ou rien (création). */
export type DraftBase = { version: number } | { sha256: string } | null

type AgentRef = Extract<DraftRef, { kind: 'agent' }>
type MemoryRef = Extract<DraftRef, { kind: 'memory' }>

/** Un type de brouillon : comment le nommer, le lire à l'état actuel, et préparer son écriture. */
export type DraftAdapter<R extends DraftRef> = {
  /** Chemin du fichier, relatif au dossier de brouillons. */
  file(ref: R): Promise<string>
  readLive(ref: R): Promise<{ text: string; base: DraftBase }>
  prepare(ref: R, text: string, base: DraftBase, stage: PendingWrites['stage']): Promise<ApiResult<PreparedWrite>>
}

export type Drafts = {
  status(): Promise<DraftsStatus>
  open(ref: DraftRef): Promise<ApiResult<DraftInfo>>
  /** Null quand le brouillon n'a jamais été ouvert ou que son fichier a disparu. */
  state(ref: DraftRef): Promise<ApiResult<DraftInfo | null>>
  prepare(ref: DraftRef): Promise<ApiResult<PreparedWrite>>
  /** Abandonne les modifications : le fichier reprend l'état actuel de l'objet. */
  discard(ref: DraftRef): Promise<ApiResult<DraftInfo>>
  back(workspaceId: string): Promise<ApiResult<null>>
  /**
   * Réécrit le fichier avec `text` : les adaptateurs l'appellent après un envoi réussi, pour que le
   * brouillon ne soit plus « non appliqué » et que la prochaine base soit celle qui vient d'être écrite.
   * Rejette si le disque refuse : l'appelant décide quoi faire d'un envoi déjà réussi.
   */
  rewrite(ref: DraftRef, text: string, base: DraftBase): Promise<void>
}

type RegistryEntry = {
  ref: DraftRef
  base: DraftBase
  writtenSha256: string
  writtenAt: string
  returnTo: { workspaceId: string; name: string } | null
}

type Registry = { entries: Record<string, RegistryEntry> }

const NOT_AVAILABLE: ApiResult<never> = { ok: false, code: 'other', error: 'Not available yet.' }
const FILE_GONE: ApiResult<never> = { ok: false, code: 'other', error: 'The draft file is gone: open it again.' }

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const refuse = (code: ApiErrorCode, error: string): { ok: false; code: ApiErrorCode; error: string } => ({ ok: false, code, error })

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/** Écrit par un fichier temporaire du même dossier puis `rename` : un lecteur ne voit jamais un fichier à moitié écrit. */
async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text)
  await rename(temporary, path)
}

async function resolvedOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

export function createDrafts(deps: {
  folder: string
  host: EditorHost
  adapters: { agent?: DraftAdapter<AgentRef>; memory?: DraftAdapter<MemoryRef> }
  pending: PendingWrites
  now: () => Date
}): Drafts {
  const { folder, host, pending, now } = deps
  const registryPath = join(folder, REGISTRY_FILE)

  // Les opérations touchent le même registre : une à la fois, sinon deux ouvertures simultanées s'écraseraient.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  const adapterFor = (ref: DraftRef): DraftAdapter<DraftRef> | undefined =>
    ref.kind === 'agent' ? deps.adapters.agent : deps.adapters.memory

  async function readRegistry(): Promise<Registry> {
    const raw = await readOrNull(registryPath)
    if (raw === null) {
      return { entries: {} }
    }
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Partial<Registry>
      return { entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {} }
    } catch {
      // Un registre illisible repart vide : les fichiers restent, seuls leurs suivis sont perdus.
      return { entries: {} }
    }
  }

  const writeRegistry = (registry: Registry): Promise<void> => writeAtomic(registryPath, JSON.stringify(registry, null, 2))

  /** Le workspace d'Orca dont le dossier est celui des brouillons (comparé par `realpath`), ou null. */
  async function findWorkspace(): Promise<{ id: string; name: string } | null> {
    await mkdir(folder, { recursive: true })
    const target = await realpath(folder)
    for (const candidate of await host.folders()) {
      if ((await resolvedOrSelf(candidate.path)) === target) {
        return { id: candidate.id, name: candidate.name }
      }
    }
    return null
  }

  /** Chemin absolu d'un fichier de brouillon, ou null quand il sortirait du dossier. */
  function inside(file: string): string | null {
    const absolute = resolve(folder, file)
    const path = relative(folder, absolute)
    return path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) ? null : absolute
  }

  async function describe(ref: DraftRef, file: string, entry: RegistryEntry): Promise<DraftInfo | null> {
    const absolute = join(folder, file)
    const content = await readOrNull(absolute)
    if (content === null) {
      return null
    }
    const saved = await stat(absolute)
    return {
      ref,
      file,
      unapplied: sha256(content) !== entry.writtenSha256,
      writtenAt: entry.writtenAt,
      savedAt: saved.mtime.toISOString(),
      returnTo: entry.returnTo
    }
  }

  /** Écrit le fichier et son entrée de registre ; `returnTo` garde sa valeur sauf si l'appelant la change. */
  async function writeDraft(
    ref: DraftRef,
    file: string,
    absolute: string,
    text: string,
    base: DraftBase,
    returnTo: RegistryEntry['returnTo']
  ): Promise<RegistryEntry> {
    await writeAtomic(absolute, text)
    const entry: RegistryEntry = { ref, base, writtenSha256: sha256(text), writtenAt: now().toISOString(), returnTo }
    const registry = await readRegistry()
    registry.entries[file] = entry
    await writeRegistry(registry)
    return entry
  }

  /** Le fichier d'un brouillon et son chemin absolu, ou le refus quand le chemin sort du dossier. */
  async function locate(
    adapter: DraftAdapter<DraftRef>,
    ref: DraftRef
  ): Promise<{ file: string; absolute: string } | ReturnType<typeof refuse>> {
    const file = await adapter.file(ref)
    const absolute = inside(file)
    return absolute === null ? refuse('other', 'The draft path is outside the drafts folder.') : { file, absolute }
  }

  return {
    async status() {
      try {
        return { folder, ready: (await findWorkspace()) !== null }
      } catch {
        return { folder, ready: false }
      }
    },

    open: (ref) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          return NOT_AVAILABLE
        }
        try {
          let workspace: { id: string; name: string } | null
          try {
            workspace = await findWorkspace()
          } catch (error) {
            return refuse('other', `Orca could not list its workspaces: ${messageOf(error)}`)
          }
          if (!workspace) {
            return refuse('drafts_missing', 'Add the drafts folder to Orca first.')
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const { file, absolute } = located

          const registry = await readRegistry()
          const known = registry.entries[file]
          const onDisk = await readOrNull(absolute)
          // Un fichier modifié depuis l'écriture du worker est le travail de Romain : on n'y touche pas.
          const keep = known !== undefined && onDisk !== null && sha256(onDisk) !== known.writtenSha256

          // Le workspace de retour : celui qui a le focus, sauf les brouillons eux-mêmes (rien où revenir).
          const focus = await host.focused().catch(() => null)
          const returnTo = focus && focus.workspaceId !== workspace.id ? focus : null

          let entry: RegistryEntry
          if (keep) {
            entry = { ...known, returnTo }
            registry.entries[file] = entry
            await writeRegistry(registry)
          } else {
            const live = await adapter.readLive(ref)
            entry = await writeDraft(ref, file, absolute, live.text, live.base, returnTo)
          }

          try {
            await host.show(workspace.id)
            await host.open(workspace.id, file)
          } catch (error) {
            return refuse('other', `Orca could not open the draft: ${messageOf(error)}`)
          }
          const info = await describe(ref, file, entry)
          return info ? { ok: true, value: info } : FILE_GONE
        } catch (error) {
          return failure(error)
        }
      }),

    state: (ref) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          return NOT_AVAILABLE
        }
        try {
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const entry = (await readRegistry()).entries[located.file]
          if (!entry) {
            return { ok: true, value: null }
          }
          return { ok: true, value: await describe(ref, located.file, entry) }
        } catch (error) {
          return failure(error)
        }
      }),

    prepare: (ref) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          return NOT_AVAILABLE
        }
        try {
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const entry = (await readRegistry()).entries[located.file]
          const content = await readOrNull(located.absolute)
          if (!entry || content === null) {
            return FILE_GONE
          }
          if (sha256(content) === entry.writtenSha256) {
            return refuse('nothing_to_apply', 'Nothing to apply: save the file first (⌘S).')
          }
          return await adapter.prepare(ref, content.toString('utf8'), entry.base, pending.stage)
        } catch (error) {
          return failure(error)
        }
      }),

    discard: (ref) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          return NOT_AVAILABLE
        }
        try {
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const { file, absolute } = located
          const known = (await readRegistry()).entries[file]
          const live = await adapter.readLive(ref)
          const entry = await writeDraft(ref, file, absolute, live.text, live.base, known?.returnTo ?? null)
          const info = await describe(ref, file, entry)
          return info ? { ok: true, value: info } : FILE_GONE
        } catch (error) {
          return failure(error)
        }
      }),

    async back(workspaceId) {
      try {
        await host.show(workspaceId)
        return { ok: true, value: null }
      } catch (error) {
        return refuse('other', `Orca could not switch back: ${messageOf(error)}`)
      }
    },

    rewrite: (ref, text, base) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          throw new Error('No adapter for this draft kind.')
        }
        const located = await locate(adapter, ref)
        if (!('file' in located)) {
          throw new Error(located.error)
        }
        const known = (await readRegistry()).entries[located.file]
        await writeDraft(ref, located.file, located.absolute, text, base, known?.returnTo ?? null)
      })
  }
}
