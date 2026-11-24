// Configurations : vues de détail (agent, env, banque de mémoire, mémoire, coffre) et ouverture dans
// la console. L'environnement et le coffre s'écrivent dans leurs formulaires (`environment-form`, `vault-forms`) ;
// l'état et les lectures sont dans `config-state`. État éphémère : seule la pile `nav` (et l'onglet, le filtre) survit à un redémarrage du panneau ;
// les vues rouvertes se rechargent par `restoreConfigView`.
import {
  Button,
  Callout,
  Code,
  IconButton,
  Markdown,
  read,
  RelativeTime,
  Row,
  shell,
  Spinner,
  Stack,
  Text,
  update
} from 'orca'
import type { ConfigDetail, ConfigKind, ConfigRow } from '../protocol'
import { clipBytes } from '../shared/text'
import { BackHeader } from '../blocks/back-header'
import { ErrorRetry } from '../blocks/error-retry'
import { LoadingState } from '../blocks/loading-state'
import { AgentFormView, leaveAgentView, TRUNCATED_NOTICE } from './agent-form'
import { EnvironmentFormView } from './environment-form'
import { MemoryActions, MemoryDeleteAction, MemoryStoreFormView, refreshStore } from './memory-forms'
import { VaultFormView } from './vault-forms'
import { configDetail, configDetailError, configRows, loadDetail, loadMemory, memoryContent, memoryError, restoreNewAgent } from './config-state'
import { ERROR_TEXT_LIMIT_BYTES, nav, popView, run, workspace } from './state'

/** Plafond d'un titre ou d'un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200

const CONSOLE_SEGMENTS: Record<ConfigKind, string> = {
  agent: 'agents',
  environment: 'environments',
  memory_store: 'memory-stores',
  vault: 'vaults'
}

/** Garde les lignes dont le nom ou l'identifiant contient la saisie, sans tenir compte de la casse. */
export function filterRows(rows: readonly ConfigRow[], query: string): ConfigRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
}

// --- Lectures ---

/**
 * Charge la vue de configuration au sommet de la pile si elle n'est pas déjà chargée : au
 * redémarrage du panneau (pile persistée), et au retour d'une mémoire vers une banque rouverte.
 */
export async function restoreConfigView(): Promise<void> {
  const top = read(nav).at(-1)
  // Un agent est toujours relu : un détail gardé d'un panneau ou d'un worker précédent peut manquer un champ (`multiagent`, 24/11)
  // ou la liste des modèles ; sa relecture recharge aussi les modèles (`loadAgentExtras`).
  if (top?.view === 'config' && (read(configDetail)?.id !== top.id || top.kind === 'agent')) {
    await loadDetail(top.kind, top.id)
  } else if (top?.view === 'credential' && read(configDetail)?.id !== top.vaultId) {
    await loadDetail('vault', top.vaultId)
  } else if (top?.view === 'memory' && read(memoryContent)?.id !== top.memoryId) {
    await loadMemory(top.memoryStoreId, top.memoryId)
  } else if (top?.view === 'newConfig') {
    await restoreNewAgent()
  }
}

function goBack(): void {
  leaveAgentView()
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

/** Le lien vers la console, en icône : un geste d'en-tête, pas une action de la page. */
function ConsoleButton({ url }: { url: string | null }) {
  return url ? <IconButton icon="open-external" label="Open in Console" variant="ghost" size="sm" onPress={() => openInConsole(url)} /> : null
}

// --- Mémoire ---

export function MemoryView({ memoryStoreId, memoryId }: { memoryStoreId: string; memoryId: string }) {
  const memory = read(memoryContent)
  const loaded = memory !== null && memory.id === memoryId ? memory : null
  const failure = read(memoryError)
  const workspaceId = read(workspace)?.workspaceId ?? null
  const at = loaded ? Date.parse(loaded.updatedAt) : Number.NaN
  return (
    <Stack gap="md">
      {/* Aucune page console n'est vérifiée pour une mémoire seule : le lien mène à sa banque. */}
      <BackHeader
        title={clipTitle(loaded?.path ?? memoryId)}
        subtitle={clipTitle(memoryId)}
        onBack={goBack}
        trailing={<ConsoleButton url={consoleUrl(workspaceId, 'memory_store', memoryStoreId)} />}
      />
      {failure ? (
        <ErrorRetry title="Could not load the memory" message={clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text} onRetry={() => run(() => loadMemory(memoryStoreId, memoryId))} />
      ) : loaded === null ? (
        <LoadingState kind="operation" label="Loading memory" />
      ) : (
        <Stack gap="md">
          {/* Les actions passent avant le contenu : un contenu de 60 Ko les repousserait hors de portée. */}
          <MemoryActions memory={loaded} />
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
          <MemoryDeleteAction memory={loaded} />
        </Stack>
      )}
    </Stack>
  )
}

// --- Vue ---

function DetailBody({ detail }: { detail: ConfigDetail }) {
  switch (detail.kind) {
    case 'agent':
      return <AgentFormView id={detail.id} />
    case 'environment':
      return <EnvironmentFormView id={detail.id} />
    case 'memory_store':
      return <MemoryStoreFormView id={detail.id} />
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
  const name = loaded?.name ?? listedName ?? id
  const url = consoleUrl(workspaceId, kind, id)
  return (
    <Stack gap="md">
      {kind === 'agent' ? (
        <DetailHeader name={name} id={id} url={url} />
      ) : (
        <BackHeader
          title={clipTitle(name)}
          subtitle={clipTitle(id)}
          onBack={goBack}
          trailing={
            kind === 'memory_store' ? (
              <Row gap="xs" align="center">
                <IconButton icon="refresh" label="Refresh" variant="ghost" size="sm" onPress={() => run(() => refreshStore(id))} />
                <ConsoleButton url={url} />
              </Row>
            ) : (
              <ConsoleButton url={url} />
            )
          }
        />
      )}
      {failure ? (
        <ErrorRetry title="Could not load the details" message={clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text} onRetry={() => run(() => loadDetail(kind, id))} />
      ) : loaded === null ? (
        <LoadingState kind="operation" label="Loading details" />
      ) : (
        <DetailBody detail={loaded} />
      )}
    </Stack>
  )
}
