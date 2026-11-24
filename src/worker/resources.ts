// Les skills et les fichiers de l'espace (Skills API et Files API, SDK 1.8.0) : listes, envois, suppressions.
// Le contenu vient du disque, lu ici (jamais par le panneau) ; l'API est celle de la clé du workspace actif.
import type { FileMetadata } from '@anthropic-ai/sdk/resources/files'
import type { Skill } from '@anthropic-ai/sdk/resources/skills/skills'
import type { ApiResult, FileRow, SkillRow } from '../protocol'
import { UPLOAD_UNCONFIRMED } from '../protocol'
import { attempt, failure, type ClientStore } from './client'
import { readSkillFolder, readUploadFile, type ReadUploads } from './resource-files'
import { NO_RETRY, unconfirmedUnlessAnswered } from './session-actions'

/**
 * Un envoi abandonne avant que le panneau cesse d'attendre (RESOURCE_UPLOAD_WAIT_MS, 120 s) : sinon il rend la
 * main pendant que l'appel court encore, la personne relance, et l'objet existe en double. Le SDK 1.8.0 arrête
 * `timeout` à l'arrivée des en-têtes : un signal, créé à chaque appel, borne aussi la lecture du corps.
 */
export const UPLOAD_TIMEOUT_MS = 105_000

export type ResourceHandlers = {
  listSkills(): Promise<ApiResult<SkillRow[]>>
  listAnthropicSkills(): Promise<ApiResult<SkillRow[]>>
  uploadSkill(input: { folder: string }): Promise<ApiResult<SkillRow>>
  uploadSkillVersion(input: { skillId: string; folder: string }): Promise<ApiResult<{ versionId: string }>>
  deleteSkill(input: { skillId: string }): Promise<ApiResult<null>>
  listFiles(): Promise<ApiResult<FileRow[]>>
  uploadFile(input: { file: string }): Promise<ApiResult<FileRow>>
  deleteFile(input: { fileId: string }): Promise<ApiResult<null>>
}

const toSkillRow = (skill: Skill): SkillRow => ({
  id: skill.id,
  name: skill.display_name,
  latestVersionId: skill.latest_version_id,
  updatedAt: skill.updated_at
})

/**
 * La session d'un fichier produit par une session. Le type stable `FileMetadata` n'a pas de champ `scope` (seul le
 * type bêta en a un) : la lecture est une garde étroite sur l'objet reçu. La branche est spéculative, aucun fichier
 * de session n'a été observé (recherche du 23/11, incertitude 1) ; sans `scope` conforme, le fichier est envoyé.
 */
function sessionIdOf(file: object): string | null {
  const scope = (file as { scope?: unknown }).scope
  if (typeof scope !== 'object' || scope === null) {
    return null
  }
  const { type, id } = scope as { type?: unknown; id?: unknown }
  return type === 'session' && typeof id === 'string' ? id : null
}

const toFileRow = (file: FileMetadata): FileRow => ({
  id: file.id,
  name: file.filename,
  sizeBytes: file.size_bytes,
  createdAt: file.created_at,
  sessionId: sessionIdOf(file)
})

/** Du plus récent au plus ancien ; `Date.parse` compare des instants, pas des chaînes de précision variable. */
const newestFirst = <T>(items: T[], dateOf: (item: T) => string): T[] =>
  [...items].sort((a, b) => Date.parse(dateOf(b)) - Date.parse(dateOf(a)))

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of pages) {
    items.push(item)
  }
  return items
}

export function createResourceHandlers(
  store: ClientStore,
  read: { skillFolder: typeof readSkillFolder; uploadFile: typeof readUploadFile } = {
    skillFolder: readSkillFolder,
    uploadFile: readUploadFile
  }
): ResourceHandlers {
  /**
   * Prend d'abord le client du workspace actif : une bascule pendant la lecture du disque ne détourne pas l'envoi
   * vers le nouveau workspace, il finit là où il a commencé. Puis lit le disque, sans réseau : un refus de lecture
   * n'envoie rien. Enfin un seul appel, sans nouvel essai et borné dans le temps. Sans réponse du serveur, l'objet a
   * pu être créé : le dire évite le doublon.
   */
  async function upload<T>(
    reading: () => Promise<ReadUploads>,
    send: (files: File[], options: { maxRetries: 0; timeout: number; signal: AbortSignal }, client: Awaited<ReturnType<ClientStore['get']>>) => Promise<T>
  ): Promise<ApiResult<T>> {
    let client: Awaited<ReturnType<ClientStore['get']>>
    try {
      client = await store.get()
    } catch (error) {
      return failure(error)
    }
    const input = await reading()
    if (!input.ok) {
      return { ok: false, code: 'invalid', error: input.error }
    }
    try {
      const value = await send(
        input.files,
        { ...NO_RETRY, timeout: UPLOAD_TIMEOUT_MS, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) },
        client
      )
      return { ok: true, value }
    } catch (error) {
      return failure(unconfirmedUnlessAnswered(error, UPLOAD_UNCONFIRMED))
    }
  }

  return {
    listSkills: () =>
      attempt(store, async (client) => {
        const skills = await collect(client.skills.list({ source: 'custom' }))
        return newestFirst(skills.map(toSkillRow), (row) => row.updatedAt)
      }),

    // Les skills d'Anthropic (xlsx, pptx, ...) viennent de l'API : la liste n'est jamais écrite en dur ici.
    listAnthropicSkills: () =>
      attempt(store, async (client) => {
        const skills = await collect(client.skills.list({ source: 'anthropic' }))
        return skills.map(toSkillRow)
      }),

    // Les `File` partent sans type MIME, comme dans l'exemple du SDK (`createReadStream`). Si l'API en refuse un
    // sans, ajouter le type ici.
    uploadSkill: ({ folder }) =>
      upload(() => read.skillFolder(folder), async (files, options, client) =>
        toSkillRow(await client.skills.create({ files }, options))
      ),

    uploadSkillVersion: ({ skillId, folder }) =>
      upload(() => read.skillFolder(folder), async (files, options, client) => {
        const version = await client.skills.versions.create(skillId, { files }, options)
        return { versionId: version.id }
      }),

    // `params` vient avant `options` dans la signature du SDK : l'objet vide garde NO_RETRY à sa place.
    // Sans cela, un nouvel essai après une réponse perdue dirait « Not found (404) » pour une suppression réussie.
    deleteSkill: ({ skillId }) =>
      attempt(store, async (client) => {
        await client.skills.delete(skillId, {}, NO_RETRY)
        return null
      }),

    listFiles: () =>
      attempt(store, async (client) => {
        const files = await collect(client.files.list())
        return newestFirst(files.map(toFileRow), (row) => row.createdAt)
      }),

    uploadFile: ({ file }) =>
      upload(() => read.uploadFile(file), async (files, options, client) =>
        toFileRow(await client.files.upload({ file: files[0]! }, options))
      ),

    deleteFile: ({ fileId }) =>
      attempt(store, async (client) => {
        await client.files.delete(fileId, {}, NO_RETRY)
        return null
      })
  }
}
