// Accueil du panneau : la section « Workspaces » (liste des workspaces, bascule, clé), puis une barre de
// cinq onglets (Sessions, Agents, Envs, Memory, Vaults) et la liste de l'onglet choisi.
import {
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  type IconName
} from 'orca'
import type { ConfigKind, SessionRow } from '../protocol'
import { formatMoney } from '../shared/money'
import { badgeLabel, badgeTone, sortSessions } from '../shared/sessions'
import { clipBytes } from '../shared/text'
import { configErrors, configRows, loadConfigs, openConfig, openNewAgent, RENDER_ROW_CAP } from './config-state'
import { filterRows } from './config-views'
import { openNewConfig } from './environment-form'
import { openNewSession } from './new-session'
import { openSession } from './session-view'
import { ERROR_TEXT_LIMIT_BYTES, homeFilter, homeTab, loadSessions, run, sessionRows, workspace, type HomeTab } from './state'
import { WorkspacesSection } from './workspaces'


/** Plafonds d'un titre et d'une description de ligne : un libellé de plus de 1 Kio fait refuser le rendu. */
const ROW_TITLE_LIMIT_BYTES = 200
const ROW_DESCRIPTION_LIMIT_BYTES = 300

const CONFIG_TABS: { value: ConfigKind; label: string; noun: string; filter: string; icon: IconName }[] = [
  { value: 'agent', label: 'Agents', noun: 'agents', filter: 'agents', icon: 'bot' },
  { value: 'environment', label: 'Envs', noun: 'environments', filter: 'envs', icon: 'database' },
  { value: 'memory_store', label: 'Memory', noun: 'memory stores', filter: 'memory', icon: 'layers' },
  { value: 'vault', label: 'Vaults', noun: 'vaults', filter: 'vaults', icon: 'plug' }
]

const HOME_TABS: { value: HomeTab; label: string; icon: IconName }[] = [
  { value: 'sessions', label: 'Sessions', icon: 'activity' },
  ...CONFIG_TABS
]

/** Libellé du bouton « + » de chaque onglet : il nomme l'action pour les lecteurs d'écran et dans l'infobulle. */
const NEW_LABELS: Record<ConfigKind, string> = {
  agent: 'New agent',
  environment: 'New environment',
  memory_store: 'New memory store',
  vault: 'New vault'
}

function openNew(kind: ConfigKind): void {
  if (kind === 'agent') openNewAgent()
  else openNewConfig(kind)
}

/**
 * Le filtre de l'onglet et, à sa droite, le bouton « + » de création. Composé en natif : `SearchBar` du kit
 * dessine ses actions en `ghost sm`, trop discrètes pour la seule action de création de l'onglet.
 */
function FilterRow({ noun, newLabel, onNew }: { noun: string; newLabel: string; onNew: () => void }) {
  return (
    <Row gap="sm" align="center">
      {[
        // Même arbre à chaque rendu : le champ garde le focus pendant la frappe.
        <Box key="field" grow minWidth={0}>
          <Input
            label="Filter"
            labelHidden
            type="search"
            placeholder={`Filter ${noun}`}
            value={read(homeFilter)}
            onChange={(value) => set(homeFilter, value)}
          />
        </Box>,
        <Box key="new" shrink={false}>
          <IconButton icon="add" label={newLabel} variant="outline" onPress={onNew} />
        </Box>
      ]}
    </Row>
  )
}

function ConfigList({ tab }: { tab: (typeof CONFIG_TABS)[number] }) {
  const rows = read(configRows)[tab.value]
  const failure = read(configErrors)[tab.value] ?? null
  const query = read(homeFilter)
  const shown = rows ? filterRows(rows, query) : []
  return (
    <Stack gap="sm">
      <FilterRow noun={tab.filter} newLabel={NEW_LABELS[tab.value]} onNew={() => openNew(tab.value)} />
      {failure ? (
        <Callout tone="danger" title="Could not load the list">
          <Stack gap="sm">
            <Text size="sm">{clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text}</Text>
            <Row>
              <Button variant="outline" size="sm" onPress={() => run(() => loadConfigs(tab.value))}>
                Retry
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {rows === undefined ? (
        failure ? null : <Spinner label={`Loading ${tab.noun}`} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? 'Nothing here yet' : 'No match'}
          {...(rows.length === 0 ? {} : { description: 'No item matches this filter.' })}
        />
      ) : (
        <Stack gap="xs">
          <List label={tab.label}>
            {shown.slice(0, RENDER_ROW_CAP).map((row) => (
              <ListItem
                key={row.id}
                title={clipBytes(row.name, ROW_TITLE_LIMIT_BYTES).text}
                description={clipBytes(row.summary, ROW_DESCRIPTION_LIMIT_BYTES).text}
                onPress={() => openConfig(row.kind, row.id)}
              />
            ))}
          </List>
          {shown.length > RENDER_ROW_CAP ? (
            <Text muted size="xs">
              {`Showing the first ${RENDER_ROW_CAP} of ${shown.length}. Refine the filter to see the rest.`}
            </Text>
          ) : null}
        </Stack>
      )}
    </Stack>
  )
}

/** Filtre les sessions sur leur titre, leur identifiant ou le nom de leur agent, sans tenir compte de la casse. */
export function filterSessions(rows: readonly SessionRow[], query: string): SessionRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...rows]
  return rows.filter((row) =>
    [row.title, row.id, row.agentName].some((field) => field?.toLowerCase().includes(needle))
  )
}

function SessionsList() {
  const loaded = read(sessionRows)
  const rows = filterSessions(sortSessions(loaded ?? []), read(homeFilter))
  return (
    <Stack gap="sm">
      <FilterRow noun="sessions" newLabel="New session" onNew={openNewSession} />
      {loaded === null ? (
        <Spinner label="Loading sessions" />
      ) : loaded.length === 0 ? (
        <Text muted size="sm">
          No sessions yet.
        </Text>
      ) : rows.length === 0 ? (
        <EmptyState title="No match" description="No session matches this filter." />
      ) : (
        <List label="Sessions">
          {rows.map((row) => (
            <ListItem
              key={row.id}
              title={clipBytes(row.title ?? row.id, ROW_TITLE_LIMIT_BYTES).text}
              description={clipBytes([row.agentName, formatMoney(row.cost)].filter(Boolean).join(' · '), ROW_DESCRIPTION_LIMIT_BYTES).text}
              onPress={() => openSession(row.id)}
            >
              <Badge tone={badgeTone(row.badge)}>{badgeLabel(row.badge)}</Badge>
            </ListItem>
          ))}
        </List>
      )}
    </Stack>
  )
}

function selectTab(tab: HomeTab): void {
  set(homeTab, tab)
  // Les lignes déjà lues restent affichées pendant la relecture.
  run(() => (tab === 'sessions' ? loadSessions() : loadConfigs(tab)))
}

/** Les cinq onglets et la liste de l'onglet choisi, sans section repliable autour. */
function HomeTabs() {
  const current = read(homeTab)
  const configTab = CONFIG_TABS.find((tab) => tab.value === current)
  return (
    <Stack gap="sm">
      {/* Les `Tabs` d'Orca ne passent jamais à la ligne (coupés dès 312 px) : une rangée de boutons le fait. */}
      <Box direction="row" wrap gap="xs" padding="xs" radius="lg" background="muted">
        {HOME_TABS.map((tab) => (
          <Button
            key={tab.value}
            size="sm"
            icon={tab.icon}
            variant={tab.value === current ? 'solid' : 'ghost'}
            // Un bouton plein neutre se fond dans la pastille : l'accent marque l'onglet actif.
            {...(tab.value === current ? { tone: 'accent' as const } : {})}
            onPress={() => selectTab(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </Box>
      {configTab ? <ConfigList key={configTab.value} tab={configTab} /> : <SessionsList />}
    </Stack>
  )
}

export function Home() {
  const info = read(workspace)
  if (!info) {
    return null
  }
  const needsKey = !info.hasKey || info.keyRejected
  return (
    <Stack gap="md">
      <WorkspacesSection info={info} />
      {needsKey ? null : <HomeTabs />}
    </Stack>
  )
}
