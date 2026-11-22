// Configurations : vues de détail (agent, env, banque de mémoire, mémoire, coffre) et ouverture dans
// la console. L'environnement et le coffre s'écrivent dans leurs formulaires (`environment-form`, `vault-forms`) ;
// l'état et les lectures sont dans `config-state`. État éphémère : seule la pile `nav` (et l'onglet, le filtre) survit à un redémarrage du panneau ;
// les vues rouvertes se rechargent par `restoreConfigView`.
import {
  atom,
  Button,
  Callout,
  Card,
  Code,
  CodeView,
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
  DraftRef,
  MemoryContent,
  MemoryStoreDetail,
  ToolPolicy,
  ToolsetView
} from '../protocol'
import { clipBytes } from '../shared/text'
import { DraftControls, loadDraftControls } from './drafts'
import { EnvironmentFormView } from './environment-form'
import { VaultFormView } from './vault-forms'
import { configDetail, configDetailError, configRows, loadDetail, RENDER_ROW_CAP } from './config-state'
import { ERROR_TEXT_LIMIT_BYTES, nav, popView, pushView, run, workspace } from './state'

/** Mention affichée sous un texte coupé côté worker. */
const TRUNCATED_NOTICE = 'Truncated, open in Console for the full text'

/** Plafond d'un titre ou d'un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200
const DESCRIPTION_LIMIT_BYTES = 300
/** Plafond d'une description d'agent : sous les 16 Kio qu'Orca accepte par `Text`, avec marge. */
const LONG_TEXT_LIMIT_BYTES = 4_000

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

// --- État ---

const memoryContent = atom<MemoryContent | null>('configs.memory', null)
const memoryError = atom<string | null>('configs.memory.error', null)

/** Garde les lignes dont le nom ou l'identifiant contient la saisie, sans tenir compte de la casse. */
export function filterRows(rows: readonly ConfigRow[], query: string): ConfigRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
}

// --- Lectures ---

async function loadMemory(memoryStoreId: string, memoryId: string): Promise<void> {
  set(memoryContent, null)
  set(memoryError, null)
  const result = await plugin.request('memory.read', { memoryStoreId, memoryId })
  const top = read(nav).at(-1)
  if (top?.view !== 'memory' || top.memoryStoreId !== memoryStoreId || top.memoryId !== memoryId) return
  if (result.ok) {
    set(memoryContent, result.value)
    await loadDraftControls(memoryDraft(memoryStoreId, memoryId, result.value.path))
  } else {
    set(memoryError, result.error)
  }
}

/** Le brouillon d'une mémoire existante. */
function memoryDraft(memoryStoreId: string, memoryId: string, path: string): DraftRef {
  return { kind: 'memory', memoryStoreId, memoryId, path }
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
  } else if (top?.view === 'credential' && read(configDetail)?.id !== top.vaultId) {
    await loadDetail('vault', top.vaultId)
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
          <DraftControls draftRef={memoryDraft(memoryStoreId, memoryId, loaded.path)} label="Edit content" />
        </Stack>
      )}
    </Stack>
  )
}

// --- Vue ---

function DetailBody({ detail }: { detail: ConfigDetail }) {
  switch (detail.kind) {
    case 'agent':
      return <AgentBody agent={detail} />
    case 'environment':
      return <EnvironmentFormView id={detail.id} />
    case 'memory_store':
      return <MemoryStoreBody store={detail} />
    case 'vault':
      return <VaultFormView id={detail.id} />
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
