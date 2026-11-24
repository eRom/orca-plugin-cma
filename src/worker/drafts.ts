// Le dossier de brouillons : Romain édite un agent ou une mémoire comme un fichier, dans un onglet
// d'éditeur d'Orca. Le worker écrit le fichier, garde dans un registre ce qu'il y a écrit (empreinte,
// base de lecture, workspace de retour), et sait donc dire si le fichier a été modifié depuis.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ApiErrorCode, ApiResult, DraftInfo, DraftRef, DraftsStatus, PreparedWrite } from '../protocol'
import { NO_KEY_MESSAGE, failure } from './client'
import type { DraftsHost } from './editor-host'
import type { PendingWrites } from './pending-writes'

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

/** Longueur du `localId` gardée dans le nom du modèle : l'onglet de l'éditeur n'affiche pas un UUID entier. */
const NEW_AGENT_ID_LENGTH = 8

/**
 * Le modèle « New agent » d'un workspace : un fichier par workspace (`localId`), pour qu'aucun ne reprenne le
 * brouillon d'un autre. Le nom ne porte que les premiers caractères du `localId` (un UUID aléatoire).
 */
export const newAgentFile = (localId: string): string => `agents/new-agent--${localId.slice(0, NEW_AGENT_ID_LENGTH)}.yaml`

/** Les modèles nommés avec le `localId` entier (avant les noms courts) : le groupe capturé est ce `localId`. */
const FULL_ID_NEW_AGENT_FILE = /^agents\/new-agent--(.+)\.yaml$/

/** Le nom fixe du modèle « New agent » d'avant les workspaces. */
const LEGACY_NEW_AGENT_FILE = 'agents/new-agent.yaml'

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
  /**
   * `recordedGone` : l'objet que le registre mémorisait pour ce brouillon n'existe plus (une mémoire supprimée
   * ailleurs, dont l'id est un 404). L'entrée est alors remplacée par `ref`, jamais fusionnée avec l'ancienne.
   */
  readLive(ref: R): Promise<{ text: string; base: DraftBase; recordedGone?: true }>
  prepare(ref: R, text: string, base: DraftBase, stage: PendingWrites['stage']): Promise<ApiResult<PreparedWrite>>
}

export type Drafts = {
  status(): Promise<DraftsStatus>
  /**
   * Ouvre le brouillon dans l'éditeur. Son workspace de retour est celui qui avait le focus quand il diffère de
   * celui des brouillons, sinon null : le bouton de retour n'existe que si cette ouverture a changé de workspace.
   * `keepReturnTo` : une réouverture interne, faite alors que le focus est déjà aux brouillons (le fichier d'un
   * agent qui vient d'être créé), garde le retour de l'entrée au lieu de l'effacer.
   */
  open(ref: DraftRef, options?: { keepReturnTo?: boolean }): Promise<ApiResult<DraftInfo>>
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
   * `returnTo` : le workspace de retour d'un brouillon qui n'a pas encore d'entrée (le fichier canonique d'un
   * agent créé reprend celui du modèle) ; une entrée existante garde le sien.
   */
  rewrite(ref: DraftRef, text: string, base: DraftBase, sent: string, returnTo?: ReturnTo | null): Promise<boolean>
  /**
   * Les brouillons du registre dont la référence vérifie `match`, avec leur fichier et leur état. Lecture
   * seule, sans appel réseau, et hors de la file des opérations : un adaptateur peut l'appeler depuis
   * `file`, `readLive` ou `prepare` sans bloquer. Un registre illisible se lit comme vide (il n'est mis de
   * côté que par une vraie opération).
   */
  find(match: (ref: DraftRef) => boolean): Promise<{ ref: DraftRef; file: string; unapplied: boolean }[]>
  /**
   * L'objet d'un brouillon a changé de chemin ou disparu : les brouillons propres (fichier tel que le worker
   * l'a écrit, ou disparu) dont la référence vérifie `match` sont oubliés, entrée et fichier, pour que leur nom
   * serve à un autre. Un brouillon non appliqué n'est jamais perdu : son fichier reste, et `kept` le dit. Avec
   * `becomes`, son entrée prend la référence que cette fonction rend et n'a plus de base (l'objet n'existe plus :
   * le brouillon est celui d'un objet à créer).
   */
  release(match: (ref: DraftRef) => boolean, becomes?: (ref: DraftRef) => DraftRef): Promise<{ released: string[]; kept: string[] }>
}

export type ReturnTo = { workspaceId: string; name: string }

/**
 * Les workspaces Anthropic vus par les brouillons : un brouillon appartient à celui où il a été ouvert (son `localId`).
 * `legacy` : le workspace issu de la migration, auquel reviennent les entrées d'avant les workspaces.
 */
export type DraftsWorkspace = {
  active(): Promise<string | null>
  legacy(): Promise<string | null>
  nameOf(localId: string): Promise<string | null>
}

type RegistryEntry = {
  ref: DraftRef
  base: DraftBase
  writtenSha256: string
  writtenAt: string
  returnTo: ReturnTo | null
  /** Le `localId` du workspace où le brouillon a été ouvert. */
  workspace: string
}

/** Un ancien registre peut encore porter un `lastReturnTo` : il est ignoré à la lecture et disparaît à la prochaine écriture. */
type Registry = {
  entries: Record<string, RegistryEntry>
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

/**
 * L'entrée du registre d'un fichier et la clé sous laquelle elle est rangée. La casse ne compte pas :
 * APFS ne distingue pas `/A.md` de `/a.md`, deux noms qui ne seraient pas comparés écraseraient un même fichier.
 */
function slotOf(registry: Registry, file: string): { key: string; entry: RegistryEntry } | undefined {
  const folded = file.toLowerCase()
  const key = Object.keys(registry.entries).find((candidate) => candidate.toLowerCase() === folded)
  return key === undefined ? undefined : { key, entry: registry.entries[key] }
}

/**
 * La clé d'un brouillon dans le registre, et le `file` rendu au panneau : toujours en `/`, sur tous les systèmes.
 * Un registre écrit sous macOS se lit ainsi sous Windows et inversement ; l'accès disque passe par `join(folder, file)`
 * (Node accepte `/` sous Windows).
 */
export const toPosixKey = (path: string): string => path.replace(/\\/g, '/')

/**
 * Le registre lu ; lève quand son contenu n'est pas un registre. Les clés d'un registre écrit sous Windows avant
 * les clés POSIX (`agents\x.yaml`) passent en `/` ; elles sont réécrites à la prochaine écriture.
 */
function parseRegistry(raw: Buffer): Registry {
  const parsed = JSON.parse(raw.toString('utf8')) as Partial<Registry> | null
  const entries = parsed?.entries
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('no entries object')
  }
  const normalised: Registry['entries'] = {}
  for (const [key, entry] of Object.entries(entries)) {
    normalised[toPosixKey(key)] = entry
  }
  return { entries: normalised }
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
  host: DraftsHost
  adapters: { agent?: DraftAdapter<AgentRef>; memory?: DraftAdapter<MemoryRef> }
  workspace: DraftsWorkspace
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

  /**
   * Une entrée écrite avant les workspaces n'a pas de `workspace` : elle revient à l'entrée migrée.
   * `convert` (les opérations sérialisées seulement, car cela touche au disque) : le modèle « New agent » d'avant, au
   * nom fixe, prend le nom du workspace migré. Son fichier est renommé (les modifications non appliquées survivent) et
   * le registre est réécrit tout de suite, sinon l'ancienne entrée reviendrait à la lecture suivante. Si le fichier
   * du workspace existe déjà, l'ancien reste sur disque et seule son entrée est retirée.
   * Même geste, aussi sous `convert`, pour un modèle nommé avec le `localId` entier (avant les noms courts).
   */
  async function withWorkspaces(registry: Registry, convert = false): Promise<Registry> {
    let legacy: string | null | undefined
    let changed = false
    /** Déplace le modèle `file` vers `target` (fichier compris), ou le laisse sur disque si `target` existe déjà. */
    const moveTemplate = async (file: string, entry: RegistryEntry, target: string, label: string): Promise<void> => {
      delete registry.entries[file]
      if ((await readOrNull(join(folder, target))) !== null) {
        log(`${label} ${file} left on disk: ${target} already exists`)
      } else {
        if ((await readOrNull(join(folder, file))) !== null) {
          await mkdir(dirname(join(folder, target)), { recursive: true })
          await rename(join(folder, file), join(folder, target))
        }
        registry.entries[target] = entry
      }
      changed = true
    }
    for (const [file, entry] of Object.entries(registry.entries)) {
      if (typeof entry.workspace === 'string') {
        // Un modèle nommé avec le `localId` entier du workspace de l'entrée prend le nom court.
        const fullId = convert && entry.ref.kind === 'agent' && entry.ref.agentId === null ? FULL_ID_NEW_AGENT_FILE.exec(file)?.[1] : undefined
        if (fullId !== undefined && fullId.length > NEW_AGENT_ID_LENGTH && entry.workspace === fullId) {
          await moveTemplate(file, entry, newAgentFile(fullId), 'new agent draft')
        }
        continue
      }
      legacy ??= await deps.workspace.legacy()
      entry.workspace = legacy ?? ''
      if (!convert || legacy === null || file.toLowerCase() !== LEGACY_NEW_AGENT_FILE || entry.ref.kind !== 'agent' || entry.ref.agentId !== null) {
        continue
      }
      await moveTemplate(file, entry, newAgentFile(legacy), 'legacy new agent draft')
    }
    if (changed) {
      await writeRegistry(registry)
    }
    return registry
  }

  async function readRegistry(): Promise<Registry> {
    const raw = await readOrNull(registryPath)
    if (raw === null) {
      return { entries: {} }
    }
    let registry: Registry
    try {
      registry = parseRegistry(raw)
    } catch (error) {
      // Un registre illisible est mis de côté, jamais jeté : Romain peut y retrouver ce qu'il suivait.
      const aside = `${registryPath}.corrupt-${stamp()}`
      await rename(registryPath, aside)
      log(`drafts registry unreadable (${messageOf(error)}); moved to ${aside}`)
      return { entries: {} }
    }
    return withWorkspaces(registry, true)
  }

  const writeRegistry = (registry: Registry): Promise<void> => writeAtomic(registryPath, JSON.stringify(registry, null, 2))

  /**
   * Le workspace d'Orca qui contient le dossier des brouillons (comparé par `realpath`), le plus proche s'il y en
   * a plusieurs, ou null. `prefix` est le chemin du dossier relatif au workspace, en `/` ('' si c'est le workspace).
   */
  async function findWorkspace(): Promise<{ id: string; name: string; prefix: string } | null> {
    // Seul le dernier niveau se crée : un projet supprimé du disque ne doit pas renaître sous son ancien chemin.
    try {
      await mkdir(folder)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return null
      if (code !== 'EEXIST') throw error
    }
    const target = await realpath(folder)
    let best: { id: string; name: string; prefix: string } | null = null
    for (const candidate of await host.folders()) {
      const inside = relative(await resolvedOrSelf(candidate.path), target)
      if (inside !== '' && (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))) {
        continue
      }
      if (best === null || inside.length < best.prefix.length) {
        best = { id: candidate.id, name: candidate.name, prefix: toPosixKey(inside) }
      }
    }
    return best
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
    returnTo: ReturnTo | null,
    workspace: string
  ): Promise<RegistryEntry> {
    await writeAtomic(join(folder, file), text)
    const entry: RegistryEntry = {
      ref: recordedRef(registry.entries[file]?.ref, ref),
      base,
      writtenSha256: sha256(text),
      writtenAt: now().toISOString(),
      returnTo,
      workspace
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
    const inFolder = relative(folder, resolve(folder, await adapter.file(ref)))
    // Le garde-fou lit le chemin natif (séparateur du système), avant la mise en `/`.
    if (inFolder === '' || inFolder === '..' || inFolder.startsWith(`..${sep}`) || isAbsolute(inFolder)) {
      return refuse('other', 'The draft path is outside the drafts folder.')
    }
    const file = toPosixKey(inFolder)
    // Le registre, son exemplaire mis de côté, les fichiers temporaires et les copies de secours
    // (`.recovered-`) sont à nous : un brouillon ne s'y ouvre ni ne s'y écrit.
    if (file.startsWith(REGISTRY_FILE) || file.endsWith('.tmp') || file.includes('.recovered-')) {
      return refuse('other', 'This draft file name is reserved.')
    }
    return { file }
  }

  /** Le fichier d'un brouillon est propre : absent, ou tel que le worker l'a écrit (aucun travail à perdre). */
  async function isClean(file: string, entry: RegistryEntry): Promise<boolean> {
    const content = await readOrNull(join(folder, file))
    return content === null || sha256(content) === entry.writtenSha256
  }

  /**
   * Le fichier que `ref` va occuper et l'entrée qu'il reprend. Une entrée d'une AUTRE référence dont le brouillon
   * est propre est périmée (objet supprimé, recréé ou déplacé ailleurs) : elle est retirée du registre, en mémoire,
   * et le nouveau brouillon la remplace. Non appliquée, elle garde son nom : le refus protège le travail qu'elle tient.
   * `replaces` désigne en plus les références qu'une écriture réussie a rendues périmées, propres ou non.
   */
  async function claim(
    registry: Registry,
    file: string,
    ref: DraftRef,
    active: string,
    replaces: (other: DraftRef) => boolean = () => false
  ): Promise<{ file: string; known: RegistryEntry | undefined; replaced: boolean } | typeof NAME_TAKEN> {
    const slot = slotOf(registry, file)
    if (!slot) {
      return { file, known: undefined, replaced: false }
    }
    if (slot.entry.workspace !== active) {
      // Le brouillon d'un workspace encore dans l'index n'est jamais repris ni remplacé, propre ou non. Celui d'un
      // workspace retiré n'a plus de maître (retirer puis ré-ajouter le même workspace donne un autre `localId`) :
      // l'actif l'adopte tel quel, fichier et travail non appliqué gardés, puis le traitement ordinaire suit.
      if ((await deps.workspace.nameOf(slot.entry.workspace)) !== null) {
        return NAME_TAKEN
      }
      slot.entry.workspace = active
    }
    if (sameRef(slot.entry.ref, ref)) {
      return { file: slot.key, known: slot.entry, replaced: false }
    }
    if (!replaces(slot.entry.ref) && !(await isClean(slot.key, slot.entry))) {
      return NAME_TAKEN
    }
    delete registry.entries[slot.key]
    return { file: slot.key, known: undefined, replaced: true }
  }

  /**
   * Le refus d'un brouillon qui appartient à un autre workspace que l'actif, ou null. Posé avant de chercher le fichier :
   * l'adaptateur peut le demander au réseau, avec la clé de l'actif. Le brouillon de création d'agent est un fichier par
   * workspace : une référence sans id n'est jamais celle d'un autre.
   */
  async function foreignRefusal(
    adapter: DraftAdapter<DraftRef>,
    registry: Registry,
    ref: DraftRef,
    active: string,
    verb: 'apply' | 'discard'
  ): Promise<ReturnType<typeof refuse> | null> {
    if (adapter.check?.(ref) || (ref.kind === 'agent' && ref.agentId === null)) {
      return null
    }
    const owners = Object.values(registry.entries).filter((entry) => sameRef(entry.ref, ref))
    if (owners.length === 0 || owners.some((entry) => entry.workspace === active)) {
      return null
    }
    const name = await deps.workspace.nameOf(owners[0].workspace)
    return refuse('other', name === null ? 'This draft belongs to a workspace that was removed.' : `This draft belongs to ${name}. Switch to it to ${verb}.`)
  }

  return {
    async find(match) {
      let entries: Registry['entries']
      let active: string | null
      try {
        const raw = await readOrNull(registryPath)
        entries = raw === null ? {} : (await withWorkspaces(parseRegistry(raw))).entries
        active = await deps.workspace.active()
      } catch {
        return []
      }
      const found: { ref: DraftRef; file: string; unapplied: boolean }[] = []
      for (const [file, entry] of Object.entries(entries)) {
        if (entry.workspace !== active || !match(entry.ref)) {
          continue
        }
        const content = await readOrNull(join(folder, file)).catch(() => null)
        found.push({ ref: entry.ref, file, unapplied: content !== null && sha256(content) !== entry.writtenSha256 })
      }
      return found
    },

    release: (match, becomes) =>
      serial(async () => {
        const active = await deps.workspace.active()
        const registry = await readRegistry()
        const released: string[] = []
        const kept: string[] = []
        let converted = false
        for (const [file, entry] of Object.entries(registry.entries)) {
          // Les brouillons d'un autre workspace ne sont ni lus ni touchés.
          if (entry.workspace !== active || !match(entry.ref)) {
            continue
          }
          const content = await readOrNull(join(folder, file))
          if (content !== null && sha256(content) !== entry.writtenSha256) {
            kept.push(file)
            if (becomes) {
              registry.entries[file] = { ...entry, ref: becomes(entry.ref), base: null }
              converted = true
            }
            continue
          }
          // Le fichier est la copie propre de l'objet : le supprimer ne perd rien.
          await rm(join(folder, file), { force: true })
          delete registry.entries[file]
          released.push(file)
        }
        if (released.length > 0 || converted) {
          await writeRegistry(registry)
        }
        return { released, kept }
      }),

    async status() {
      try {
        return { folder, ready: (await findWorkspace()) !== null }
      } catch {
        return { folder, ready: false }
      }
    },

    open: (ref, options) =>
      serial(async () => {
        const adapter = adapterFor(ref)
        if (!adapter) {
          return NOT_AVAILABLE
        }
        try {
          const active = await deps.workspace.active()
          if (active === null) {
            return refuse('no_key', NO_KEY_MESSAGE)
          }
          let workspace: { id: string; name: string; prefix: string } | null
          try {
            workspace = await findWorkspace()
          } catch (error) {
            return refuse('other', `Orca could not list its workspaces: ${messageOf(error)}`)
          }
          if (!workspace) {
            return refuse('drafts_missing', 'The drafts project is not open in Orca. Choose it again in the Drafts section of the home.')
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const registry = await readRegistry()
          // Deux brouillons sur un même nom de fichier (noms qui se ressemblent, casse comprise) : le second ne reprend
          // rien du premier, sauf si celui-ci est propre (périmé). Le fichier garde la casse sous laquelle il a été écrit.
          const claimed = await claim(registry, located.file, ref, active)
          if (!('file' in claimed)) {
            return claimed
          }
          const { file, known, replaced } = claimed
          const absolute = join(folder, file)
          const onDisk = await readOrNull(absolute)
          // Un fichier modifié depuis l'écriture du worker est le travail de Romain : on n'y touche pas.
          const keep = known !== undefined && onDisk !== null && sha256(onDisk) !== known.writtenSha256

          // Le bouton de retour n'existe que si cette ouverture a changé de workspace : le workspace qui avait le
          // focus quand il diffère de celui des brouillons, sinon rien (déjà dans les brouillons, ou aucun focus).
          const focus = await host.focused().catch(() => null)
          const away = focus && focus.workspaceId !== workspace.id ? focus : null
          const returnTo = away ?? (options?.keepReturnTo ? (known?.returnTo ?? null) : null)

          let entry: RegistryEntry
          if (keep) {
            entry = { ...known, returnTo }
            registry.entries[file] = entry
            await writeRegistry(registry)
          } else {
            const live = await adapter.readLive(ref)
            // Sans entrée de registre, un fichier présent peut être un travail non appliqué : on le met de côté.
            // Une entrée périmée remplacée était propre : son fichier n'est pas un travail.
            if (known === undefined && !replaced && onDisk !== null && onDisk.toString('utf8') !== live.text) {
              // Écrite directement, d'après les octets lus : pas de fichier temporaire (son suffixe ferait dépasser
              // les 255 octets d'un nom de segment au plafond) et pas de relecture en texte, qui altérerait des octets non UTF-8.
              const recovered = `${absolute}.recovered-${stamp()}`
              await writeFile(recovered, onDisk)
              log(`draft ${file} had no registry entry and differed from the live object; kept a copy at ${recovered}`)
            }
            if (live.recordedGone) {
              delete registry.entries[file]
            }
            entry = await writeDraft(registry, ref, file, live.text, live.base, returnTo, active)
          }

          try {
            await host.show(workspace.id)
            await host.open(workspace.id, workspace.prefix === '' ? file : `${workspace.prefix}/${file}`)
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
          // Le registre seul répond : un brouillon jamais ouvert n'a pas besoin que l'adaptateur lui cherche un fichier
          // (ce qui demanderait le réseau pour une mémoire).
          const problem = adapter.check?.(ref)
          if (problem) {
            return refuse('invalid', problem)
          }
          // Un brouillon d'un autre workspace n'existe pas ici : ni listé, ni appliqué.
          const active = await deps.workspace.active()
          if (active === null) {
            return { ok: true, value: null }
          }
          const slot = Object.entries((await readRegistry()).entries).find(([, entry]) => entry.workspace === active && sameRef(entry.ref, ref))
          if (!slot) {
            return { ok: true, value: null }
          }
          return { ok: true, value: await describe(ref, slot[0], slot[1]) }
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
          const active = await deps.workspace.active()
          if (active === null) {
            return refuse('no_key', NO_KEY_MESSAGE)
          }
          const registry = await readRegistry()
          const foreign = await foreignRefusal(adapter, registry, ref, active, 'apply')
          if (foreign) {
            return foreign
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          const slot = slotOf(registry, located.file)
          const entry = slot && slot.entry.workspace === active && sameRef(slot.entry.ref, ref) ? slot.entry : undefined
          const content = await readOrNull(join(folder, slot?.key ?? located.file))
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
          const active = await deps.workspace.active()
          if (active === null) {
            return refuse('no_key', NO_KEY_MESSAGE)
          }
          const registry = await readRegistry()
          const foreign = await foreignRefusal(adapter, registry, ref, active, 'discard')
          if (foreign) {
            return foreign
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            return located
          }
          // Écraser le fichier d'un autre brouillon non appliqué perdrait son travail : on refuse.
          const claimed = await claim(registry, located.file, ref, active)
          if (!('file' in claimed)) {
            return claimed
          }
          const { file, known } = claimed
          const live = await adapter.readLive(ref)
          if (live.recordedGone) {
            delete registry.entries[file]
          }
          const entry = await writeDraft(registry, ref, file, live.text, live.base, known?.returnTo ?? null, active)
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

    rewrite: (ref, text, base, sent, inheritedReturnTo) =>
      serial(async () => {
        try {
          const adapter = adapterFor(ref)
          if (!adapter) {
            throw new Error('no adapter for this draft kind')
          }
          const active = await deps.workspace.active()
          if (active === null) {
            throw new Error(NO_KEY_MESSAGE)
          }
          const located = await locate(adapter, ref)
          if (!('file' in located)) {
            throw new Error(located.error)
          }
          const registry = await readRegistry()
          // L'envoi a réussi : une mémoire créée à ce chemin rend périmée toute autre référence de ce chemin (l'API
          // n'y garde qu'une mémoire), propre ou non : ce qu'elle tenait est ce qui vient d'être envoyé.
          const supersedes = (other: DraftRef): boolean =>
            ref.kind === 'memory' && other.kind === 'memory' && other.memoryStoreId === ref.memoryStoreId && other.path === ref.path
          const claimed = await claim(registry, located.file, ref, active, supersedes)
          if (!('file' in claimed)) {
            throw new Error(claimed.error)
          }
          const { file, known } = claimed
          const returnTo = known?.returnTo ?? inheritedReturnTo ?? null
          const onDisk = await readOrNull(join(folder, file))
          if (onDisk === null || sha256(onDisk) === sha256(sent)) {
            await writeDraft(registry, ref, file, text, base, returnTo, active)
            return true
          }
          // Romain a sauvegardé autre chose pendant l'envoi : son fichier reste, et ce qu'il contient
          // se compare désormais à la nouvelle base, donc reste « non appliqué ».
          registry.entries[file] = {
            ref: recordedRef(known?.ref, ref),
            base,
            writtenSha256: sha256(text),
            writtenAt: now().toISOString(),
            returnTo,
            workspace: active
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
