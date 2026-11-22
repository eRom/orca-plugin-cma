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
import type { MemoryStoreUpdateParams } from '@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores'
import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsCredentialNetworkingParams,
  CredentialCreateParams,
  CredentialUpdateParams
} from '@anthropic-ai/sdk/resources/beta/vaults/credentials'
import type {
  ApiResult,
  CredentialForm,
  CredentialNetworkForm,
  EnvironmentForm,
  KeyValueItem,
  MemoryStoreForm,
  PackageLists,
  ResourceRef,
  SaveInput,
  Saved,
  VaultForm
} from '../protocol'
import { validateCredentialForm } from '../shared/credential-rules'
import { cleaned, validateEnvironmentForm } from '../shared/environment-rules'
import { CONFLICT_MESSAGE, attempt, failure, type ClientStore } from './client'

// La règle vit dans `shared/` pour que le panneau la lise aussi ; elle reste importable d'ici.
export { validateCredentialForm }
// Le message vit dans `client.ts` (`describeError` en a besoin) ; il reste importable d'ici.
export { CONFLICT_MESSAGE }

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

/** Le formulaire d'un identifiant ; null pour `mcp_oauth`, qui ne se modifie pas ici. Aucun secret n'en sort. */
export function toCredentialForm(credential: BetaManagedAgentsCredential): CredentialForm | null {
  const { auth } = credential
  const name = credential.display_name ?? ''
  switch (auth.type) {
    case 'static_bearer':
      return { type: 'static_bearer', name, mcpServerUrl: auth.mcp_server_url, token: '' }
    case 'environment_variable':
      return {
        type: 'environment_variable',
        name,
        secretName: auth.secret_name,
        secretValue: '',
        network:
          auth.networking.type === 'limited'
            ? { mode: 'limited', allowedHosts: [...auth.networking.allowed_hosts] }
            : { mode: 'unrestricted' },
        injection: { header: auth.injection_location.header, body: auth.injection_location.body }
      }
    default:
      return null
  }
}

function credentialNetworking(network: CredentialNetworkForm): BetaManagedAgentsCredentialNetworkingParams {
  return network.mode === 'limited'
    ? { type: 'limited', allowed_hosts: cleaned(network.allowedHosts) }
    : { type: 'unrestricted' }
}

/** À la création, le secret et l'URL partent coupés aux bords : un collage traîne souvent un retour à la ligne. */
export function credentialCreateParams(form: CredentialForm): CredentialCreateParams {
  const name = form.name.trim()
  return {
    ...(name !== '' && { display_name: name }),
    auth:
      form.type === 'static_bearer'
        ? { type: 'static_bearer', mcp_server_url: form.mcpServerUrl.trim(), token: form.token.trim() }
        : {
            type: 'environment_variable',
            secret_name: form.secretName.trim(),
            secret_value: form.secretValue.trim(),
            networking: credentialNetworking(form.network),
            injection_location: { header: form.injection.header, body: form.injection.body }
          }
  }
}

/** La partie `auth` d'une modification, ou null quand rien d'elle ne change. L'URL et le nom de variable sont immuables. */
function credentialAuthUpdate(form: CredentialForm, base: CredentialForm): CredentialUpdateParams['auth'] | null {
  if (form.type === 'static_bearer') {
    const token = form.token.trim()
    return token === '' ? null : { type: 'static_bearer', token }
  }
  const secret = form.secretValue.trim()
  const previous = base.type === 'environment_variable' ? base : null
  const networkChanged =
    !previous || JSON.stringify(credentialNetworking(form.network)) !== JSON.stringify(credentialNetworking(previous.network))
  const injectionChanged =
    !previous || form.injection.header !== previous.injection.header || form.injection.body !== previous.injection.body
  if (secret === '' && !networkChanged && !injectionChanged) {
    return null
  }
  return {
    type: 'environment_variable',
    ...(secret !== '' && { secret_value: secret }),
    ...(networkChanged && { networking: credentialNetworking(form.network) }),
    ...(injectionChanged && { injection_location: { header: form.injection.header, body: form.injection.body } })
  }
}

/** Seul ce qui diffère de `base` part ; un secret vide n'est jamais envoyé, il garde l'ancien. */
export function credentialUpdateParams(form: CredentialForm, base: CredentialForm): Omit<CredentialUpdateParams, 'vault_id'> {
  const params: Omit<CredentialUpdateParams, 'vault_id'> = {}
  const name = form.name.trim()
  if (name !== base.name.trim()) {
    // Un nom vidé se dit par `null`.
    params.display_name = name === '' ? null : name
  }
  const auth = credentialAuthUpdate(form, base)
  if (auth) {
    params.auth = auth
  }
  return params
}

/** Seuls le nom et la description qui diffèrent de `base` partent ; une description vidée part en chaîne vide (l'API l'efface ainsi). */
export function memoryStoreUpdateParams(form: MemoryStoreForm, base: MemoryStoreForm): MemoryStoreUpdateParams {
  const params: MemoryStoreUpdateParams = {}
  if (form.name.trim() !== base.name.trim()) {
    params.name = form.name.trim()
  }
  if (form.description !== base.description) {
    params.description = form.description
  }
  return params
}

/** Vrai quand l'objet a bougé depuis son ouverture ; un enregistrement forcé passe. */
export function isStale(currentUpdatedAt: string, input: { baseUpdatedAt: string | null; force: boolean }): boolean {
  return !input.force && currentUpdatedAt !== input.baseUpdatedAt
}

export type WriteHandlers = {
  saveEnvironment(input: SaveInput<EnvironmentForm>): Promise<ApiResult<Saved>>
  saveVault(input: SaveInput<VaultForm>): Promise<ApiResult<Saved>>
  saveMemoryStore(input: SaveInput<MemoryStoreForm>): Promise<ApiResult<Saved>>
  saveCredential(input: SaveInput<CredentialForm> & { vaultId: string }): Promise<ApiResult<Saved>>
  archive(ref: ResourceRef): Promise<ApiResult<null>>
  remove(ref: ResourceRef): Promise<ApiResult<null>>
}

/** En dessous de cette longueur, un secret n'est plus remplaçable dans un message d'erreur. */
const SECRET_MIN_REDACTABLE = 8
const SECRET_REFUSED_MESSAGE = 'The API refused the credential.'

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

  async function saveVault(input: SaveInput<VaultForm>): Promise<ApiResult<Saved>> {
    const name = input.form.name.trim()
    if (name === '') {
      return invalid('A name is required.')
    }
    const { id, base } = input
    if (id === null) {
      return attempt(store, async (client) => {
        const created = await client.beta.vaults.create({ display_name: name })
        return { id: created.id, updatedAt: created.updated_at }
      })
    }
    if (base === null) {
      return invalid('The loaded version is missing.')
    }
    try {
      const client = await store.get()
      const current = await client.beta.vaults.retrieve(id)
      if (isStale(current.updated_at, input)) {
        return { ok: false, code: 'conflict', error: CONFLICT_MESSAGE }
      }
      if (name === base.name.trim()) {
        return { ok: true, value: { id: current.id, updatedAt: current.updated_at } }
      }
      const updated = await client.beta.vaults.update(id, { display_name: name })
      return { ok: true, value: { id: updated.id, updatedAt: updated.updated_at } }
    } catch (error) {
      return failure(error)
    }
  }

  async function saveMemoryStore(input: SaveInput<MemoryStoreForm>): Promise<ApiResult<Saved>> {
    const name = input.form.name.trim()
    if (name === '') {
      return invalid('A name is required.')
    }
    const { id, base } = input
    if (id === null) {
      return attempt(store, async (client) => {
        const created = await client.beta.memoryStores.create({
          name,
          ...(input.form.description !== '' && { description: input.form.description })
        })
        return { id: created.id, updatedAt: created.updated_at }
      })
    }
    if (base === null) {
      return invalid('The loaded version is missing.')
    }
    try {
      const client = await store.get()
      const current = await client.beta.memoryStores.retrieve(id)
      if (isStale(current.updated_at, input)) {
        return { ok: false, code: 'conflict', error: CONFLICT_MESSAGE }
      }
      const params = memoryStoreUpdateParams(input.form, base)
      if (Object.keys(params).length === 0) {
        return { ok: true, value: { id: current.id, updatedAt: current.updated_at } }
      }
      const updated = await client.beta.memoryStores.update(id, params)
      return { ok: true, value: { id: updated.id, updatedAt: updated.updated_at } }
    } catch (error) {
      return failure(error)
    }
  }

  async function writeCredential(input: SaveInput<CredentialForm> & { vaultId: string }): Promise<ApiResult<Saved>> {
    const { id, base, vaultId, form } = input
    const problem = validateCredentialForm(form, id === null)
    if (problem) {
      return invalid(problem)
    }
    if (id === null) {
      return attempt(store, async (client) => {
        const created = await client.beta.vaults.credentials.create(vaultId, credentialCreateParams(form))
        return { id: created.id, updatedAt: created.updated_at }
      })
    }
    if (base === null) {
      return invalid('The loaded version is missing.')
    }
    if (base.type !== form.type) {
      return invalid('The credential type cannot change.')
    }
    try {
      const client = await store.get()
      const current = await client.beta.vaults.credentials.retrieve(id, { vault_id: vaultId })
      if (isStale(current.updated_at, input)) {
        return { ok: false, code: 'conflict', error: CONFLICT_MESSAGE }
      }
      const params = credentialUpdateParams(form, base)
      if (Object.keys(params).length === 0) {
        return { ok: true, value: { id: current.id, updatedAt: current.updated_at } }
      }
      const updated = await client.beta.vaults.credentials.update(id, { vault_id: vaultId, ...params })
      return { ok: true, value: { id: updated.id, updatedAt: updated.updated_at } }
    } catch (error) {
      return failure(error)
    }
  }

  // Le secret envoyé ne doit pas ressortir dans un message d'erreur de l'API, ni dans le journal.
  async function saveCredential(input: SaveInput<CredentialForm> & { vaultId: string }): Promise<ApiResult<Saved>> {
    const result = await writeCredential(input)
    // Seul le texte venu de l'API (code 'other') peut reprendre le secret ; les autres messages sont fixes.
    if (result.ok || result.code !== 'other') {
      return result
    }
    const secret = input.form.type === 'static_bearer' ? input.form.token : input.form.secretValue
    const trimmed = secret.trim()
    if (trimmed === '') {
      return result
    }
    // Un secret très court ne se remplace pas sans abîmer le message (et le révéler) : on le jette en entier.
    if (trimmed.length < SECRET_MIN_REDACTABLE) {
      return { ...result, error: SECRET_REFUSED_MESSAGE }
    }
    // Le SDK met le corps d'erreur en JSON dans le message : un secret avec retour à la ligne, guillemet
    // ou antislash y revient échappé, d'où les deux formes pour chaque variante. Les plus longues d'abord : la
    // forme brute d'un secret en `"` ou en `\` se retrouve dans l'échappée, et la remplacer avant en laisserait un caractère.
    const escaped = (text: string) => JSON.stringify(text).slice(1, -1)
    const variants = [...new Set([secret, escaped(secret), trimmed, escaped(trimmed)])].sort((a, b) => b.length - a.length)
    return { ...result, error: variants.reduce((text, variant) => text.split(variant).join('[secret]'), result.error) }
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
    saveVault: (input) => logged('vault.save', saveVault(input)),
    saveMemoryStore: (input) => logged('memoryStore.save', saveMemoryStore(input)),
    saveCredential: (input) => logged('credential.save', saveCredential(input)),
    archive: (ref) => logged('resource.archive', archive(ref)),
    remove: (ref) => logged('resource.delete', remove(ref))
  }
}
