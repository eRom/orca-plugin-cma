// Écritures sur les configurations : conversions pures (formulaire ↔ paramètres de l'API) et
// handlers réseau. Le formulaire est la seule forme que le panneau envoie ; le worker décide ce
// qui part vers l'API (seulement ce qui a changé) et refuse une écriture sur un objet modifié ailleurs.
import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaCloudConfigParams,
  BetaEnvironment,
  EnvironmentCreateParams,
  EnvironmentUpdateParams
} from '@anthropic-ai/sdk/resources/beta/environments/environments'
import type {
  ApiResult,
  EnvironmentForm,
  KeyValueItem,
  PackageLists,
  ResourceRef,
  SaveInput,
  Saved
} from '../protocol'
import { cleaned, validateEnvironmentForm } from '../shared/environment-rules'
import { attempt, failure, type ClientStore } from './client'

export const CONFLICT_MESSAGE = 'Changed elsewhere since you opened it.'

const emptyPackages = (): PackageLists => ({ apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] })

export function toEnvironmentForm(env: BetaEnvironment): EnvironmentForm {
  const common = {
    name: env.name,
    description: env.description ?? '',
    metadata: Object.entries(env.metadata).map(([key, value]) => ({ key, value }))
  }
  if (env.config.type !== 'cloud') {
    // `self_hosted` ne décrit ni réseau ni paquets : l'hôte les gère.
    return { ...common, hosting: 'self_hosted', network: { mode: 'unrestricted' }, packages: emptyPackages() }
  }
  const { networking, packages } = env.config
  return {
    ...common,
    hosting: 'cloud',
    network:
      networking.type === 'limited'
        ? {
            mode: 'limited',
            allowedHosts: [...networking.allowed_hosts],
            allowPackageManagers: networking.allow_package_managers,
            allowMcpServers: networking.allow_mcp_servers
          }
        : { mode: 'unrestricted' },
    packages: {
      apt: [...packages.apt],
      cargo: [...packages.cargo],
      gem: [...packages.gem],
      go: [...packages.go],
      npm: [...packages.npm],
      pip: [...packages.pip]
    }
  }
}

/** Les paires du formulaire en objet ; une clé vide est ignorée. */
function toRecord(items: KeyValueItem[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const { key, value } of items) {
    if (key.trim() !== '') record[key.trim()] = value
  }
  return record
}

/** Pour `metadata` à la mise à jour : une clé retirée part à `null`, seules les clés nouvelles ou changées sont envoyées. */
export function metadataPatch(form: KeyValueItem[], base: KeyValueItem[]): Record<string, string | null> {
  const next = toRecord(form)
  const previous = toRecord(base)
  const patch: Record<string, string | null> = {}
  for (const key of Object.keys(previous)) {
    if (!(key in next)) patch[key] = null
  }
  for (const [key, value] of Object.entries(next)) {
    if (previous[key] !== value) patch[key] = value
  }
  return patch
}

function networkingParams(network: EnvironmentForm['network']): NonNullable<BetaCloudConfigParams['networking']> {
  return network.mode === 'limited'
    ? {
        type: 'limited',
        allowed_hosts: cleaned(network.allowedHosts),
        allow_package_managers: network.allowPackageManagers,
        allow_mcp_servers: network.allowMcpServers
      }
    : { type: 'unrestricted' }
}

function packagesParams(packages: PackageLists): NonNullable<BetaCloudConfigParams['packages']> {
  return {
    type: 'packages',
    apt: cleaned(packages.apt),
    cargo: cleaned(packages.cargo),
    gem: cleaned(packages.gem),
    go: cleaned(packages.go),
    npm: cleaned(packages.npm),
    pip: cleaned(packages.pip)
  }
}

function cloudConfig(form: EnvironmentForm): BetaCloudConfigParams {
  return { type: 'cloud', networking: networkingParams(form.network), packages: packagesParams(form.packages) }
}

export function environmentCreateParams(form: EnvironmentForm): EnvironmentCreateParams {
  return {
    name: form.name.trim(),
    ...(form.description !== '' && { description: form.description }),
    config: form.hosting === 'cloud' ? cloudConfig(form) : { type: 'self_hosted' },
    metadata: toRecord(form.metadata)
  }
}

/** Seuls les champs de premier niveau qui diffèrent de `base` partent ; dans `config`, seul le réseau ou seuls les paquets modifiés partent. */
export function environmentUpdateParams(form: EnvironmentForm, base: EnvironmentForm): EnvironmentUpdateParams {
  const params: EnvironmentUpdateParams = {}
  if (form.name.trim() !== base.name.trim()) {
    params.name = form.name.trim()
  }
  if (form.description !== base.description) {
    // Une description vidée se dit par `null` : l'API garde sinon une chaîne vide.
    params.description = form.description === '' ? null : form.description
  }
  const patch = metadataPatch(form.metadata, base.metadata)
  if (Object.keys(patch).length > 0) {
    params.metadata = patch
  }
  if (form.hosting === 'cloud') {
    // Le SDK dit « omit on update to preserve » pour chacun : seule la partie modifiée part.
    const networkChanged = JSON.stringify(networkingParams(form.network)) !== JSON.stringify(networkingParams(base.network))
    const packagesChanged = JSON.stringify(packagesParams(form.packages)) !== JSON.stringify(packagesParams(base.packages))
    if (networkChanged || packagesChanged) {
      params.config = {
        type: 'cloud',
        ...(networkChanged && { networking: networkingParams(form.network) }),
        ...(packagesChanged && { packages: packagesParams(form.packages) })
      }
    }
  }
  return params
}

/** Vrai quand l'objet a bougé depuis son ouverture ; un enregistrement forcé passe. */
export function isStale(currentUpdatedAt: string, input: { baseUpdatedAt: string | null; force: boolean }): boolean {
  return !input.force && currentUpdatedAt !== input.baseUpdatedAt
}

export type WriteHandlers = {
  saveEnvironment(input: SaveInput<EnvironmentForm>): Promise<ApiResult<Saved>>
  archive(ref: ResourceRef): Promise<ApiResult<null>>
  remove(ref: ResourceRef): Promise<ApiResult<null>>
}

const invalid = (error: string): { ok: false; error: string; code: 'invalid' } => ({ ok: false, error, code: 'invalid' })

/** Les types qui s'archivent : une mémoire n'a que la suppression. */
type Archivable = Exclude<ResourceRef, { kind: 'memory' }>

/** Les types qui se suppriment : un agent n'a que l'archivage. */
type Deletable =
  | { kind: 'environment' | 'vault' | 'memory_store' | 'session'; id: string }
  | Extract<ResourceRef, { kind: 'credential' | 'memory' }>

// TypeScript ne retire pas `agent` d'un membre à discriminant multiple : un garde le fait.
const isDeletable = (ref: ResourceRef): ref is Deletable => ref.kind !== 'agent'

function archiveCall(client: Anthropic, ref: Archivable): Promise<unknown> {
  switch (ref.kind) {
    case 'agent':
      return client.beta.agents.archive(ref.id)
    case 'environment':
      return client.beta.environments.archive(ref.id)
    case 'vault':
      return client.beta.vaults.archive(ref.id)
    case 'memory_store':
      return client.beta.memoryStores.archive(ref.id)
    case 'session':
      return client.beta.sessions.archive(ref.id)
    case 'credential':
      return client.beta.vaults.credentials.archive(ref.id, { vault_id: ref.vaultId })
  }
}

function deleteCall(client: Anthropic, ref: Deletable): Promise<unknown> {
  switch (ref.kind) {
    case 'environment':
      return client.beta.environments.delete(ref.id)
    case 'vault':
      return client.beta.vaults.delete(ref.id)
    case 'memory_store':
      return client.beta.memoryStores.delete(ref.id)
    case 'session':
      return client.beta.sessions.delete(ref.id)
    case 'credential':
      return client.beta.vaults.credentials.delete(ref.id, { vault_id: ref.vaultId })
    case 'memory':
      return client.beta.memoryStores.memories.delete(ref.id, { memory_store_id: ref.memoryStoreId })
  }
}

export function createWriteHandlers(store: ClientStore, log: (message: string) => void): WriteHandlers {
  // Un échec se note par son message lisible seulement, jamais par le contenu du formulaire.
  const logged = async <T>(label: string, pending: Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    const result = await pending
    if (!result.ok) log(`${label} failed: ${result.error}`)
    return result
  }

  async function saveEnvironment(input: SaveInput<EnvironmentForm>): Promise<ApiResult<Saved>> {
    const problem = validateEnvironmentForm(input.form)
    if (problem) {
      return invalid(problem)
    }
    const { id, base } = input
    if (id === null) {
      return attempt(store, async (client) => {
        const created = await client.beta.environments.create(environmentCreateParams(input.form))
        return { id: created.id, updatedAt: created.updated_at }
      })
    }
    if (base === null) {
      return invalid('The loaded version is missing.')
    }
    // Pas d'`attempt` ici : le conflit est une réponse propre à cette écriture, pas une erreur de l'API.
    try {
      const client = await store.get()
      const current = await client.beta.environments.retrieve(id)
      if (isStale(current.updated_at, input)) {
        return { ok: false, code: 'conflict', error: CONFLICT_MESSAGE }
      }
      const params = environmentUpdateParams(input.form, base)
      // Rien n'a changé : on n'écrit pas, l'horodatage lu reste valable.
      if (Object.keys(params).length === 0) {
        return { ok: true, value: { id: current.id, updatedAt: current.updated_at } }
      }
      const updated = await client.beta.environments.update(id, params)
      return { ok: true, value: { id: updated.id, updatedAt: updated.updated_at } }
    } catch (error) {
      return failure(error)
    }
  }

  async function archive(ref: ResourceRef): Promise<ApiResult<null>> {
    if (ref.kind === 'memory') {
      return invalid('Memories can only be deleted.')
    }
    return attempt(store, async (client) => {
      await archiveCall(client, ref)
      return null
    })
  }

  async function remove(ref: ResourceRef): Promise<ApiResult<null>> {
    if (!isDeletable(ref)) {
      return invalid('Agents can only be archived.')
    }
    return attempt(store, async (client) => {
      await deleteCall(client, ref)
      return null
    })
  }

  return {
    saveEnvironment: (input) => logged('environment.save', saveEnvironment(input)),
    archive: (ref) => logged('resource.archive', archive(ref)),
    remove: (ref) => logged('resource.delete', remove(ref))
  }
}
