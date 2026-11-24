// Où vit le dossier de brouillons : un sous-dossier `managed-agents/` d'un projet de la barre latérale
// d'Orca, choisi par Romain (l'éditeur d'Orca n'ouvre que des fichiers d'un workspace). Ce module retient
// le choix, liste les projets candidats et déplace les brouillons quand le projet change.
import { cp, mkdir, readFile, readdir, realpath, rename as fsRename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ApiResult, DraftsProject } from '../protocol'
import { REGISTRY_FILE } from './drafts'

export const DRAFTS_SUBFOLDER = 'managed-agents'
/** Clé du storage du plugin qui retient l'id du projet choisi. */
export const DRAFTS_PROJECT_KEY = 'draftsProjectId'

const GITIGNORE_FILE = '.gitignore'
/** Dans un dépôt Git, le dossier de brouillons s'ignore lui-même : rien n'apparaît dans `git status`. */
const GITIGNORE_CONTENT = '*\n'

/** Un projet de la barre latérale d'Orca, tel que `project.list` le rend (les champs utilisés ici). */
export type ProjectSource = () => Promise<
  { id: string; name: string; kind: 'git' | 'folder'; hostId: string | null; path: string; hidden?: boolean }[]
>
export type KeyStore = { get(key: string): Promise<unknown>; set(key: string, value: string): Promise<void> }
type Rename = typeof fsRename

export type DraftsLocation = {
  /** Le dossier de brouillons du projet retenu, ou null (aucun choix, projet disparu ou masqué). */
  folder(): Promise<string | null>
  /** Les projets de la barre latérale : locaux (`hostId` `local` ou null), non masqués, triés par nom sans casse. */
  projects(): Promise<DraftsProject[]>
  /** Retient le projet ; déplace les brouillons de l'ancien dossier (ou de LEGACY si aucun choix) ; écrit le .gitignore. */
  choose(projectId: string): Promise<ApiResult<{ folder: string }>>
}

/** Le dossier d'avant les projets : repris au premier choix tant qu'aucun projet n'est retenu. */
export const LEGACY_DRAFTS_FOLDER = join(homedir(), '.config', 'agent-claude-managed', 'managed-agents')

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/** Le texte d'un fichier, ou null s'il n'existe pas. */
async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

/** Le nombre d'entrées d'un registre ; un registre illisible compte comme occupé, jamais comme vide. */
function registryEntryCount(text: string): number {
  try {
    const parsed = JSON.parse(text) as { entries?: unknown }
    const entries = parsed.entries
    return typeof entries === 'object' && entries !== null ? Object.keys(entries).length : 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const realOrResolved = (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

/** Déplace un fichier ou un dossier ; deux volumes différents (`EXDEV`) : copie puis suppression. */
async function moveEntry(source: string, target: string, rename: Rename): Promise<void> {
  try {
    await rename(source, target)
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EXDEV') {
      await cp(source, target, { recursive: true })
      await rm(source, { recursive: true, force: true })
      return
    }
    // Un dossier de même nom existe déjà dans la cible (vide de brouillons) : on fusionne son contenu.
    if ((code === 'ENOTEMPTY' || code === 'EEXIST') && (await stat(source)).isDirectory()) {
      await mkdir(target, { recursive: true })
      for (const name of await readdir(source)) {
        await moveEntry(join(source, name), join(target, name), rename)
      }
      await rmdir(source)
      return
    }
    throw error
  }
}

/**
 * Déplace les brouillons de `from` vers `to`. `nothing` : pas de registre dans `from`, ou même dossier.
 * `occupied` : le registre de `to` a déjà au moins une entrée, rien n'est touché. Le registre passe en dernier :
 * un déplacement interrompu laisse `from` reconnaissable et `to` libre, donc relançable.
 */
export async function moveDrafts(from: string, to: string, rename: Rename = fsRename): Promise<'moved' | 'nothing' | 'occupied'> {
  if ((await readOrNull(join(from, REGISTRY_FILE))) === null) return 'nothing'
  await mkdir(to, { recursive: true })
  if ((await realOrResolved(from)) === (await realOrResolved(to))) return 'nothing'
  const targetRegistry = await readOrNull(join(to, REGISTRY_FILE))
  if (targetRegistry !== null && registryEntryCount(targetRegistry) > 0) return 'occupied'

  const names = (await readdir(from)).filter((name) => name !== GITIGNORE_FILE && name !== REGISTRY_FILE)
  for (const name of [...names, REGISTRY_FILE]) {
    await moveEntry(join(from, name), join(to, name), rename)
  }
  // Le .gitignore posé par le plugin part avec le dossier ; un .gitignore modifié à la main reste.
  if ((await readOrNull(join(from, GITIGNORE_FILE))) === GITIGNORE_CONTENT) {
    await rm(join(from, GITIGNORE_FILE), { force: true })
  }
  try {
    await rmdir(from)
  } catch (error) {
    if (errorCode(error) !== 'ENOTEMPTY' && errorCode(error) !== 'EEXIST') throw error
  }
  return 'moved'
}

export function createDraftsLocation(deps: {
  projects: ProjectSource
  store: KeyStore
  legacyFolder: string
  log: (message: string) => void
  rename?: Rename
}): DraftsLocation {
  const { projects, store, legacyFolder, log } = deps
  const rename = deps.rename ?? fsRename

  const visible = async () =>
    (await projects()).filter((project) => (project.hostId === 'local' || project.hostId === null) && project.hidden !== true)

  const storedId = async (): Promise<string | null> => {
    const id = await store.get(DRAFTS_PROJECT_KEY)
    return typeof id === 'string' ? id : null
  }

  // Les choix s'enchaînent un à un : deux déplacements simultanés se disputeraient les mêmes fichiers.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task)
    queue = run.catch(() => undefined)
    return run
  }

  async function folder(): Promise<string | null> {
    const id = await storedId()
    if (id === null) return null
    const found = (await visible()).find((project) => project.id === id)
    return found ? join(found.path, DRAFTS_SUBFOLDER) : null
  }

  async function list(): Promise<DraftsProject[]> {
    const id = await storedId()
    return (await visible())
      .map(({ id: projectId, name, path }) => ({ id: projectId, name, path, current: projectId === id }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }

  const choose = (projectId: string): Promise<ApiResult<{ folder: string }>> =>
    serial(async () => {
      try {
        const target = (await visible()).find((project) => project.id === projectId)
        if (!target) return { ok: false, error: 'This project is not available in Orca.', code: 'invalid' }
        const targetFolder = join(target.path, DRAFTS_SUBFOLDER)

        // La source : le dossier du projet retenu (même masqué, tant qu'Orca le liste), ou l'ancien dossier
        // tant qu'aucun projet n'est retenu. Un projet retenu puis retiré d'Orca n'a plus de source.
        const previousId = await storedId()
        let sourceFolder: string | null
        if (previousId === null) {
          sourceFolder = legacyFolder
        } else {
          const previous = (await projects()).find((project) => project.id === previousId)
          sourceFolder = previous ? join(previous.path, DRAFTS_SUBFOLDER) : null
        }

        await mkdir(targetFolder, { recursive: true })
        await writeFile(join(targetFolder, GITIGNORE_FILE), GITIGNORE_CONTENT, { flag: 'wx' }).catch((error: unknown) => {
          if (errorCode(error) !== 'EEXIST') throw error
        })

        if (previousId !== projectId && sourceFolder !== null) {
          if ((await moveDrafts(sourceFolder, targetFolder, rename)) === 'occupied') {
            return {
              ok: false,
              error: 'That project already holds drafts. Remove them or pick another project.',
              code: 'drafts_occupied'
            }
          }
        }
        await store.set(DRAFTS_PROJECT_KEY, projectId)
        log(`drafts folder: ${targetFolder}`)
        return { ok: true, value: { folder: targetFolder } }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`drafts folder change failed: ${message}`)
        return { ok: false, error: `The drafts folder could not be changed: ${message}`, code: 'other' }
      }
    })

  return { folder, projects: list, choose }
}
