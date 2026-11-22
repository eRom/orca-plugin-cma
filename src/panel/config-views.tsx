// Configurations en lecture seule : lecture des listes de l'accueil, vues de détail (agent, env,
// banque de mémoire, mémoire, coffre) et ouverture dans la console. Rien n'est écrit chez l'API.
// État éphémère : seule la pile `nav` (et l'onglet, le filtre) survit à un redémarrage du panneau ;
// les vues rouvertes se rechargent par `restoreConfigView`.
import {
  atom,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
  env,
  KeyValue,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  shell,
  Spinner,
  Stack,
  Text,
  update,
  type OrcaNode
} from 'orca'
import type {
  AgentDetail,
  ConfigDetail,
  ConfigKind,
  ConfigRow,
  CredentialRow,
  CredentialType,
  EnvironmentDetail,
  KeyValueItem,
  MemoryContent,
  MemoryStoreDetail,
  ToolPolicy,
  ToolsetView,
  VaultDetail
} from '../protocol'
import { clipBytes } from '../shared/text'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popView, pushView, run, workspace } from './state'

/** Mention affichée sous un texte coupé côté worker. */
const TRUNCATED_NOTICE = 'Truncated, open in Console for the full text'

/** Plafond d'un titre ou d'un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200
const DESCRIPTION_LIMIT_BYTES = 300
/** Plafond d'une description d'agent : sous les 16 Kio qu'Orca accepte par `Text`, avec marge. */
const LONG_TEXT_LIMIT_BYTES = 4_000

/**
 * Lignes dessinées au plus par liste : un rendu est refusé au-delà de 5000 nœuds et d'environ
 * 512 Kio. Une banque de mémoire peut garder bien plus de mémoires que cela.
 */
export const RENDER_ROW_CAP = 200

const CONSOLE_SEGMENTS: Record<ConfigKind, string> = {
  agent: 'agents',
  environment: 'environments',
  memory_store: 'memory-stores',
  vault: 'vaults'
}

const POLICY_LABELS: Record<ToolPolicy, string> = {
  always_allow: 'always allow',
  always_ask: 'always ask',
  auto: 'auto'
}

const CREDENTIAL_LABELS: Record<CredentialType, string> = {
  mcp_oauth: 'MCP OAuth',
  static_bearer: 'Static bearer',
  environment_variable: 'Environment variable'
}

// --- État ---

/** Lignes des listes de l'accueil, par type ; absent tant que la première lecture n'est pas revenue. */
export const configRows = atom<Partial<Record<ConfigKind, ConfigRow[]>>>('configs.rows', {})
/** Erreur de lecture de la liste, par type. */
export const configErrors = atom<Partial<Record<ConfigKind, string | null>>>('configs.errors', {})
/** Détail de la configuration ouverte ; il reste chargé quand une mémoire s'ouvre par-dessus. */
const configDetail = atom<ConfigDetail | null>('configs.detail', null)
const configDetailError = atom<string | null>('configs.detail.error', null)
const memoryContent = atom<MemoryContent | null>('configs.memory', null)
const memoryError = atom<string | null>('configs.memory.error', null)

/** Oublie les listes lues (clé changée ou oubliée) : elles ne valent plus pour la nouvelle clé. */
export function resetConfigs(): void {
  set(configRows, {})
  set(configErrors, {})
}

/** Garde les lignes dont le nom ou l'identifiant contient la saisie, sans tenir compte de la casse. */
export function filterRows(rows: readonly ConfigRow[], query: string): ConfigRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
}

// --- Lectures ---

/**
 * Lit la liste d'un type. Sans clé utilisable il n'y a rien à lire ; un 401 est l'état « clé
 * refusée » : on relit l'identité du workspace, qui remontre le formulaire. Les lignes déjà lues
 * restent affichées pendant la relecture.
 */
export async function loadConfigs(kind: ConfigKind): Promise<void> {
  const info = read(workspace)
  if (!info?.hasKey || info.keyRejected) return
  const result = await plugin.request('configs.list', { kind })
  if (result.ok) {
    update(configRows, (current) => ({ ...current, [kind]: result.value }))
    update(configErrors, (current) => ({ ...current, [kind]: null }))
  } else if (result.code === 'unauthorized') {
    await loadWorkspace()
  } else {
    update(configErrors, (current) => ({ ...current, [kind]: result.error }))
  }
}

/** Vrai tant que la vue au sommet de la pile est cette configuration. */
function isConfigOnTop(kind: ConfigKind, id: string): boolean {
  const top = read(nav).at(-1)
  return top?.view === 'config' && top.kind === kind && top.id === id
}

async function loadDetail(kind: ConfigKind, id: string): Promise<void> {
  set(configDetail, null)
  set(configDetailError, null)
  const result = await plugin.request('configs.detail', { kind, id })
  // Retour ou autre vue ouverte pendant la lecture : cette réponse ne sert plus.
  if (!isConfigOnTop(kind, id)) return
  if (result.ok) {
    set(configDetail, result.value)
  } else {
    set(configDetailError, result.error)
  }
}

async function loadMemory(memoryStoreId: string, memoryId: string): Promise<void> {
  set(memoryContent, null)
  set(memoryError, null)
  const result = await plugin.request('memory.read', { memoryStoreId, memoryId })
  const top = read(nav).at(-1)
  if (top?.view !== 'memory' || top.memoryStoreId !== memoryStoreId || top.memoryId !== memoryId) return
  if (result.ok) {
    set(memoryContent, result.value)
  } else {
    set(memoryError, result.error)
  }
}

/** Ouvre le détail d'une configuration depuis l'accueil : empile la vue, puis la charge. */
export function openConfig(kind: ConfigKind, id: string): void {
  update(nav, (stack) => pushView(stack, { view: 'config', kind, id }))
  run(() => loadDetail(kind, id))
}

/** Ouvre une mémoire depuis le détail de sa banque. */
export function openMemory(memoryStoreId: string, memoryId: string): void {
  update(nav, (stack) => pushView(stack, { view: 'memory', memoryStoreId, memoryId }))
  run(() => loadMemory(memoryStoreId, memoryId))
}

/**
 * Charge la vue de configuration au sommet de la pile si elle n'est pas déjà chargée : au
 * redémarrage du panneau (pile persistée), et au retour d'une mémoire vers une banque rouverte.
 */
export async function restoreConfigView(): Promise<void> {
  const top = read(nav).at(-1)
  if (top?.view === 'config' && read(configDetail)?.id !== top.id) {
    await loadDetail(top.kind, top.id)
  } else if (top?.view === 'memory' && read(memoryContent)?.id !== top.memoryId) {
    await loadMemory(top.memoryStoreId, top.memoryId)
  }
}

function goBack(): void {
  update(nav, popView)
  run(restoreConfigView)
}

function openInConsole(url: string): void {
  // L'appui sur ce bouton est le geste que `shell.openExternal` exige.
  run(async () => {
    await shell.openExternal(url)
  })
}

// --- Rendu commun ---

function consoleUrl(workspaceId: string | null, kind: ConfigKind, id: string): string | null {
  return workspaceId ? `https://platform.claude.com/workspaces/${workspaceId}/${CONSOLE_SEGMENTS[kind]}/${encodeURIComponent(id)}` : null
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString(env.locale, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clipTitle(text: string): string {
  return clipBytes(text, TITLE_LIMIT_BYTES).text
}

function DetailHeader({ name, id, url }: { name: string; id: string; url: string | null }) {
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" justify="between" wrap>
        <Button variant="ghost" size="sm" onPress={goBack}>
          ‹ Back
        </Button>
        {url ? (
          <Button variant="outline" size="sm" icon="open-external" onPress={() => openInConsole(url)}>
            Open in Console
          </Button>
        ) : null}
      </Row>
      <Stack gap="xs">
        <Text weight="semibold">{clipTitle(name)}</Text>
        <Row>
          <Code>{clipTitle(id)}</Code>
        </Row>
      </Stack>
    </Stack>
  )
}

function Truncated() {
  return (
    <Text muted size="xs">
      {TRUNCATED_NOTICE}
    </Text>
  )
}

/** Erreur brute de l'API : le titre reste un libellé fixe, le texte va en enfant. */
function LoadFailure({ title, message }: { title: string; message: string }) {
  return (
    <Callout tone="danger" title={title}>
      <Text size="sm">{clipBytes(message, ERROR_TEXT_LIMIT_BYTES).text}</Text>
    </Callout>
  )
}

/** Mention sous une liste coupée au plafond de rendu. */
function CapNotice({ total }: { total: number }) {
  return total > RENDER_ROW_CAP ? (
    <Text muted size="xs">
      {`Showing the first ${RENDER_ROW_CAP} of ${total}. Open in Console for the rest.`}
    </Text>
  ) : null
}

function Section({ title, children }: { title: string; children: OrcaNode }) {
  return (
    <Stack gap="xs">
      <Text size="sm" weight="medium">
        {title}
      </Text>
      {children}
    </Stack>
  )
}

function items(pairs: readonly KeyValueItem[]): { label: string; value: string }[] {
  return pairs.map((pair) => ({ label: clipTitle(pair.key), value: clipBytes(pair.value, LONG_TEXT_LIMIT_BYTES).text }))
}

// --- Agent ---

function toolsetDefault(view: ToolsetView): string {
  return `Default: ${view.enabled ? 'enabled' : 'disabled'}${view.policy ? `, ${POLICY_LABELS[view.policy]}` : ''}`
}

function ToolsetSummary({ view, label }: { view: ToolsetView; label: string }) {
  return (
    <Stack gap="sm">
      <Text size="sm">{toolsetDefault(view)}</Text>
      {view.overrides.length > 0 ? (
        <KeyValue
          label={label}
          items={view.overrides.slice(0, RENDER_ROW_CAP).map((tool) => ({
            label: clipTitle(tool.name),
            value: `${tool.enabled ? 'enabled' : 'disabled'}${tool.policy ? `, ${POLICY_LABELS[tool.policy]}` : ''}`
          }))}
        />
      ) : null}
    </Stack>
  )
}

function AgentBody({ agent }: { agent: AgentDetail }) {
  const description = agent.description ? clipBytes(agent.description, LONG_TEXT_LIMIT_BYTES).text : null
  return (
    <Stack gap="md">
      <KeyValue
        label="Agent"
        items={[
          { label: 'Version', value: `v${agent.version}` },
          { label: 'Model', value: clipTitle(agent.model), code: true },
          ...(agent.effort ? [{ label: 'Effort', value: agent.effort }] : []),
          ...(description ? [{ label: 'Description', value: description }] : [])
        ]}
      />
      <Section title="System prompt">
        {agent.system.text ? (
          <CodeView code={agent.system.text} label="System prompt" wrap maxHeight="md" />
        ) : (
          <Text muted size="sm">
            No system prompt.
          </Text>
        )}
        {agent.system.truncated ? <Truncated /> : null}
      </Section>
      <Section title="Tools">
        {agent.builtinTools ? (
          <Card title="Built-in tools">
            <ToolsetSummary view={agent.builtinTools} label="Built-in tool settings" />
          </Card>
        ) : (
          <Text muted size="sm">
            No built-in toolset.
          </Text>
        )}
        {agent.mcpServers.slice(0, RENDER_ROW_CAP).map((server) => (
          <Card key={server.name} title={clipTitle(server.name)} description={clipBytes(server.url, DESCRIPTION_LIMIT_BYTES).text}>
            <ToolsetSummary view={server} label={`${clipTitle(server.name)} tool settings`} />
          </Card>
        ))}
        <CapNotice total={agent.mcpServers.length} />
      </Section>
      {agent.skills.length > 0 ? <Text size="sm">{`Skills: ${clipBytes(agent.skills.join(', '), LONG_TEXT_LIMIT_BYTES).text}`}</Text> : null}
      {agent.multiagent ? <Text size="sm">{clipBytes(agent.multiagent, LONG_TEXT_LIMIT_BYTES).text}</Text> : null}
    </Stack>
  )
}

// --- Environnement ---

function EnvironmentBody({ environment }: { environment: EnvironmentDetail }) {
  const { network } = environment
  const networkLabel = network.mode === 'unrestricted' ? 'Unrestricted' : network.mode === 'limited' ? 'Limited' : 'Managed by the host'
  return (
    <Stack gap="md">
      <KeyValue
        label="Environment"
        items={[
          { label: 'Type', value: environment.hosting },
          { label: 'Network', value: networkLabel },
          ...(network.mode === 'limited'
            ? [
                { label: 'Package managers', value: network.allowPackageManagers ? 'allowed' : 'blocked' },
                { label: 'MCP servers', value: network.allowMcpServers ? 'allowed' : 'blocked' }
              ]
            : [])
        ]}
      />
      {network.mode === 'limited' ? (
        <Section title="Allowed hosts">
          {network.allowedHosts.length === 0 ? (
            <Text muted size="sm">
              No allowed hosts.
            </Text>
          ) : (
            <List label="Allowed hosts">
              {network.allowedHosts.slice(0, RENDER_ROW_CAP).map((host) => (
                <ListItem key={host} title={clipTitle(host)} />
              ))}
            </List>
          )}
          <CapNotice total={network.allowedHosts.length} />
        </Section>
      ) : null}
      {environment.packages.length > 0 ? (
        <Section title="Packages">
          <KeyValue label="Packages" items={items(environment.packages)} />
        </Section>
      ) : null}
      {environment.metadata.length > 0 ? (
        <Section title="Metadata">
          <KeyValue label="Metadata" items={items(environment.metadata)} />
        </Section>
      ) : null}
    </Stack>
  )
}

// --- Banque de mémoire, mémoire ---

function MemoryStoreBody({ store }: { store: MemoryStoreDetail }) {
  return (
    <Stack gap="md">
      {store.description ? <Text size="sm">{clipBytes(store.description, LONG_TEXT_LIMIT_BYTES).text}</Text> : null}
      <Section title="Memories">
        {store.memories.length === 0 ? (
          <Text muted size="sm">
            No memories yet.
          </Text>
        ) : (
          <List label="Memories">
            {store.memories.slice(0, RENDER_ROW_CAP).map((memory) => {
              const at = Date.parse(memory.updatedAt)
              return (
                <ListItem key={memory.id} title={clipTitle(memory.path)} description={formatSize(memory.sizeBytes)} onPress={() => openMemory(store.id, memory.id)}>
                  {Number.isNaN(at) ? null : <RelativeTime at={at} format="short" muted />}
                </ListItem>
              )
            })}
          </List>
        )}
        <CapNotice total={store.memories.length} />
      </Section>
    </Stack>
  )
}

export function MemoryView({ memoryStoreId, memoryId }: { memoryStoreId: string; memoryId: string }) {
  const memory = read(memoryContent)
  const loaded = memory !== null && memory.id === memoryId ? memory : null
  const failure = read(memoryError)
  const workspaceId = read(workspace)?.workspaceId ?? null
  const at = loaded ? Date.parse(loaded.updatedAt) : Number.NaN
  return (
    <Stack gap="md">
      {/* Aucune page console n'est vérifiée pour une mémoire seule : le lien mène à sa banque. */}
      <DetailHeader name={loaded?.path ?? memoryId} id={memoryId} url={consoleUrl(workspaceId, 'memory_store', memoryStoreId)} />
      {failure ? (
        <LoadFailure title="Could not load the memory" message={failure} />
      ) : loaded === null ? (
        <Spinner label="Loading memory" />
      ) : (
        <Stack gap="sm">
          {Number.isNaN(at) ? null : (
            <Text muted size="sm">
              Updated <RelativeTime at={at} format="long" />
            </Text>
          )}
          {loaded.content.text ? (
            <Markdown content={loaded.content.text} />
          ) : (
            <Text muted size="sm">
              This memory is empty.
            </Text>
          )}
          {loaded.content.truncated ? <Truncated /> : null}
        </Stack>
      )}
    </Stack>
  )
}

// --- Coffre ---

function credentialDescription(credential: CredentialRow): string {
  const parts: string[] = [CREDENTIAL_LABELS[credential.type]]
  if (credential.mcpServerUrl) parts.push(clipBytes(credential.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text)
  if (credential.expiresAt) parts.push(`expires ${formatDate(credential.expiresAt)}`)
  return parts.join(' · ')
}

function VaultBody({ vault }: { vault: VaultDetail }) {
  return (
    <Section title="Credentials">
      {vault.credentials.length === 0 ? (
        <Text muted size="sm">
          No credentials yet.
        </Text>
      ) : (
        <List label="Credentials">
          {vault.credentials.slice(0, RENDER_ROW_CAP).map((credential) => (
            <ListItem key={credential.id} title={clipTitle(credential.name)} description={credentialDescription(credential)} />
          ))}
        </List>
      )}
      <CapNotice total={vault.credentials.length} />
    </Section>
  )
}

// --- Vue ---

function DetailBody({ detail }: { detail: ConfigDetail }) {
  switch (detail.kind) {
    case 'agent':
      return <AgentBody agent={detail} />
    case 'environment':
      return <EnvironmentBody environment={detail} />
    case 'memory_store':
      return <MemoryStoreBody store={detail} />
    case 'vault':
      return <VaultBody vault={detail} />
  }
}

export function ConfigDetailView({ kind, id }: { kind: ConfigKind; id: string }) {
  const detail = read(configDetail)
  const loaded = detail !== null && detail.id === id ? detail : null
  const failure = read(configDetailError)
  const listedName = read(configRows)[kind]?.find((row) => row.id === id)?.name
  const workspaceId = read(workspace)?.workspaceId ?? null
  return (
    <Stack gap="md">
      <DetailHeader name={loaded?.name ?? listedName ?? id} id={id} url={consoleUrl(workspaceId, kind, id)} />
      {failure ? (
        <LoadFailure title="Could not load the details" message={failure} />
      ) : loaded === null ? (
        <Spinner label="Loading details" />
      ) : (
        <DetailBody detail={loaded} />
      )}
    </Stack>
  )
}
