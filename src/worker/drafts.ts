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
  /**
   * Refus d'une référence avant tout accès au disque ou au réseau : le texte du problème, ou null.
   * Il revient au panneau en `invalid`.
   */
  check?(ref: R): string | null
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
   * Après un envoi réussi : le fichier reprend `text` (l'état écrit) et le registre garde `base`.
   * `sent` est le texte du brouillon qui vient d'être envoyé : si le fichier a changé depuis (Romain a
   * sauvegardé entre-temps), ses modifications plus récentes sont gardées et le brouillon reste « non appliqué ».
   * Ne rejette jamais, l'envoi étant déjà fait : rend false (et journalise) quand le disque refuse.
   */
  rewrite(ref: DraftRef, text: string, base: DraftBase, sent: string): Promise<boolean>
  /**
   * Les brouillons du registre dont la référence vérifie `match`, avec leur fichier et leur état. Lecture
   * seule, sans appel réseau, et hors de la file des opérations : un adaptateur peut l'appeler depuis
   * `file`, `readLive` ou `prepare` sans bloquer. Un registre illisible se lit comme vide (il n'est mis de
   * côté que par une vraie opération).
   */
  find(match: (ref: DraftRef) => boolean): Promise<{ ref: DraftRef; file: string; unapplied: boolean }[]>
}

type ReturnTo = { workspaceId: string; name: string }

type RegistryEntry = {
  ref: DraftRef
  base: DraftBase
  writtenSha256: string
  writtenAt: string
  returnTo: ReturnTo | null
}

type Registry = {
  entries: Record<string, RegistryEntry>
  /** Le dernier workspace de travail vu au focus : le retour d'un brouillon ouvert depuis les brouillons eux-mêmes. */
  lastReturnTo: ReturnTo | null
}

const NOT_AVAILABLE: ApiResult<never> = { ok: false, code: 'other', error: 'Not available yet.' }
const FILE_GONE: ApiResult<never> = { ok: false, code: 'other', error: 'The draft file is gone: open it again.' }
const NAME_TAKEN = { ok: false, code: 'other', error: 'Another draft already uses this file name.' } as const

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const refuse = (code: ApiErrorCode, error: string): { ok: false; code: ApiErrorCode; error: string } => ({ ok: false, code, error })

/**
 * Deux références désignent le même brouillon. Une mémoire se reconnaît à son id quand les deux en ont un
 * (son chemin a pu changer par un renommage), sinon à son chemin : une création et la mémoire qu'elle a
 * produite (l'entrée du registre a pris son id) restent un seul brouillon.
 */
export function sameRef(a: DraftRef, b: DraftRef): boolean {
  if (a.kind === 'agent' && b.kind === 'agent') {
    return a.agentId === b.agentId
  }
  if (a.kind === 'memory' && b.kind === 'memory') {
    if (a.memoryStoreId !== b.memoryStoreId) {
      return false
    }
    return a.memoryId !== null && b.memoryId !== null ? a.memoryId === b.memoryId : a.path === b.path
  }
  return false
}

/**
 * La référence à garder dans le registre : celle qui porte l'id d'une mémoire quand une seule en a un.
 * Un brouillon rouvert par la référence de sa création (sans id) ne fait donc pas oublier la mémoire créée.
 */
function recordedRef(known: DraftRef | undefined, ref: DraftRef): DraftRef {
  return known?.kind === 'memory' && ref.kind === 'memory' && ref.memoryId === null && known.memoryId !== null ? known : ref
}

/** Le registre lu tel quel ; lève quand son contenu n'est pas un registre. */
function parseRegistry(raw: Buffer): Registry {
  const parsed = JSON.parse(raw.toString('utf8')) as Partial<Registry> | null
  const entries = parsed?.entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('no entries object')
  }
  return { entries, lastReturnTo: parsed.lastReturnTo ?? null }
}

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
  log: (message: string) => void
}): Drafts {
  const { folder, host, pending, now, log } = deps
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

  /** Horodatage sûr dans un nom de fichier. */
  const stamp = (): string => now().toISOString().replace(/[:.]/g, '-')

  async function readRegistry(): Promise<Registry> {
    const raw = await readOrNull(registryPath)
    if (raw === null) {
      return { entries: {}, lastReturnTo: null }
    }
    try {
      return parseRegistry(raw)
    } catch (error) {
      // Un registre illisible est mis de côté, jamais jeté : Romain peut y retrouver ce qu'il suivait.
      const aside = `${registryPath}.corrupt-${stamp()}`
      await rename(registryPath, aside)
      log(`drafts registry unreadable (${messageOf(error)}); moved to ${aside}`)
      return { entries: {}, lastReturnTo: null }
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

  /** Écrit le fichier, puis son entrée dans `registry` (déjà lu par l'appelant) et le registre sur disque. */
  async function writeDraft(
    registry: Registry,
    ref: DraftRef,
    file: string,
    text: string,
    base: DraftBase,
    returnTo: ReturnTo | null
  ): Promise<RegistryEntry> {
    await writeAtomic(join(folder, file), text)
    const entry: RegistryEntry = {
      ref: recordedRef(registry.entries[file]?.ref, ref),
      base,
      writtenSha256: sha256(text),
      writtenAt: now().toISOString(),
      returnTo
    }
    registry.entries[file] = entry
    await writeRegistry(registry)
    return entry
  }

  /** Le fichier d'un brouillon (relatif, normalisé), ou le refus quand son nom sort du dossier ou est réservé. */
  async function locate(adapter: DraftAdapter<DraftRef>, ref: DraftRef): Promise<{ file: string } | ReturnType<typeof refuse>> {
    const problem = adapter.check?.(ref)
    if (problem) {
      return refuse('invalid', problem)
    }
    const file = relative(folder, resolve(folder, await adapter.file(ref)))
    if (file === '' || file === '..' || file.startsWith(`..${sep}`) || isAbsolute(file)) {
      return refuse('other', 'The draft path is outside the drafts folder.')
    }
    // Le registre, son exemplaire mis de côté, les fichiers temporaires et les copies de secours
    // (`.recovered-`) sont à nous : un brouillon ne s'y ouvre ni ne s'y écrit.
    if (file.startsWith(REGISTRY_FILE) || file.endsWith('.tmp') || file.includes('.recovered-')) {
      return refuse('other', 'This draft file name is reserved.')
    }
    return { file }
  }

  /** L'entrée de registre d'un fichier, seulement si elle est celle de ce brouillon. */
  const entryOf = (registry: Registry, file: string, ref: DraftRef): RegistryEntry | undefined => {
    const entry = registry.entries[file]
    return entry && sameRef(entry.ref, ref) ? entry : undefined
  }

  return {
    async find(match) {
      let entries: Registry['entries']
      try {
        const raw = await readOrNull(registryPath)
        entries = raw === null ? {} : parseRegistry(raw).entries
      } catch {
        return []
      }
      const found: { ref: DraftRef; file: string; unapplied: boolean }[] = []
      for (const [file, entry] of Object.entries(entries)) {
        if (!match(entry.ref)) {
          continue
        }
        const content = await readOrNull(join(folder, file)).catch(() => null)
        found.push({ ref: entry.ref, file, unapplied: content !== null && sha256(content) !== entry.writtenSha256 })
      }
      return found
    },

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
          const { file } = located
          const absolute = join(folder, file)

          const registry = await readRegistry()
          const known = registry.entries[file]
          // Deux brouillons sur un même nom de fichier (noms qui se ressemblent) : le second ne reprend rien du premier.
          if (known && !sameRef(known.ref, ref)) {
            return NAME_TAKEN
          }
          const onDisk = await readOrNull(absolute)
          // Un fichier modifié depuis l'écriture du worker est le travail de Romain : on n'y touche pas.
          const keep = known !== undefined && onDisk !== null && sha256(onDisk) !== known.writtenSha256

          // Le workspace de retour : celui qui a le focus ; depuis les brouillons eux-mêmes, le précédent.
          const focus = await host.focused().catch(() => null)
          const away = focus && focus.workspaceId !== workspace.id ? focus : null
          if (away) {
            registry.lastReturnTo = away
          }
          const returnTo = away ?? known?.returnTo ?? registry.lastReturnTo

          let entry: RegistryEntry
          if (keep) {
            entry = { ...known, returnTo }
            registry.entries[file] = entry
            await writeRegistry(registry)
          } else {
            const live = await adapter.readLive(ref)
            // Sans entrée de registre, un fichier présent peut être un travail non appliqué : on le met de côté.
            if (known === undefined && onDisk !== null && onDisk.toString('utf8') !== live.text) {
              const recovered = `${absolute}.recovered-${stamp()}`
              await writeAtomic(recovered, onDisk.toString('utf8'))
              log(`draft ${file} had no registry entry and differed from the live object; kept a copy at ${recovered}`)
            }
            entry = await writeDraft(registry, ref, file, live.text, live.base, returnTo)
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
          const entry = entryOf(await readRegistry(), located.file, ref)
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
          const entry = entryOf(await readRegistry(), located.file, ref)
          const content = await readOrNull(join(folder, located.file))
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
          const { file } = located
          const registry = await readRegistry()
          const known = registry.entries[file]
          // Écraser le fichier d'un autre brouillon perdrait son travail : on refuse.
          if (known && !sameRef(known.ref, ref)) {
            return NAME_TAKEN
          }
          const live = await adapter.readLive(ref)
          const entry = await writeDraft(registry, ref, file, live.text, live.base, known?.returnTo ?? registry.lastReturnTo)
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

    rewrite: (ref, text, base, sent) =>
      serial(async () => {
        try {
          const adapter = adapterFor(ref)
          if (!adapter) {
            throw new Error('no adapter for this draft kind')
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            throw new Error(located.error)
          }
          const { file } = located
          const registry = await readRegistry()
          const known = registry.entries[file]
          if (known && !sameRef(known.ref, ref)) {
            throw new Error(NAME_TAKEN.error)
          }
          const returnTo = known?.returnTo ?? registry.lastReturnTo
          const onDisk = await readOrNull(join(folder, file))
          if (onDisk === null || sha256(onDisk) === sha256(sent)) {
            await writeDraft(registry, ref, file, text, base, returnTo)
            return true
          }
          // Romain a sauvegardé autre chose pendant l'envoi : son fichier reste, et ce qu'il contient
          // se compare désormais à la nouvelle base, donc reste « non appliqué ».
          registry.entries[file] = {
            ref: recordedRef(known?.ref, ref),
            base,
            writtenSha256: sha256(text),
            writtenAt: now().toISOString(),
            returnTo
          }
          await writeRegistry(registry)
          return true
        } catch (error) {
          log(`draft rewrite failed after a successful send: ${messageOf(error)}`)
          return false
        }
      })
  }
}
