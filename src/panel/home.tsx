// Accueil du panneau : les sections « Anthropic workspace » (clé et identité), « Configurations »
// (4 onglets en lecture seule) et « Sessions ».
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Collapsible,
  EmptyState,
  Input,
  Link,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type IconName
} from 'orca'
import { formatMoney } from '../shared/money'
import { badgeLabel, badgeTone, sortSessions } from '../shared/sessions'
import { clipBytes } from '../shared/text'
import {
  configErrors,
  configRows,
  filterRows,
  loadConfigs,
  openConfig,
  RENDER_ROW_CAP,
  resetConfigs,
  restoreConfigView
} from './config-views'
import { openNewSession, restoreNewSession } from './new-session'
import { openSession, restoreOpenSession } from './session-view'
import { ERROR_TEXT_LIMIT_BYTES, homeFilter, homeTab, loadSessions, run, sectionsOpen, sessionRows, workspace, type HomeTab } from './state'

/** Plafonds d'un titre et d'une description de ligne : un libellé de plus de 1 Kio fait refuser le rendu. */
const ROW_TITLE_LIMIT_BYTES = 200
const ROW_DESCRIPTION_LIMIT_BYTES = 300

const CONFIG_TABS: { value: HomeTab; label: string; noun: string; icon: IconName }[] = [
  { value: 'agent', label: 'Agents', noun: 'agents', icon: 'bot' },
  { value: 'environment', label: 'Envs', noun: 'environments', icon: 'database' },
  { value: 'memory_store', label: 'Memory', noun: 'memory stores', icon: 'layers' },
  { value: 'vault', label: 'Vaults', noun: 'vaults', icon: 'plug' }
]

const keyDraft = atom('')
const KEY_REJECTED = 'The API key was rejected (401).'

async function saveKey(): Promise<void> {
  const result = await plugin.request('key.set', { key: read(keyDraft).trim() })
  if (result.ok) {
    set(keyDraft, '')
    set(workspace, result.value)
    // Les sessions et les listes de l'ancienne clé ne valent plus rien : on relit celles de la nouvelle.
    set(sessionRows, null)
    resetConfigs()
    await loadSessions()
    // Une vue de session restée au sommet de la pile (clé absente ou refusée au démarrage) n'a jamais chargé son fil.
    await Promise.all([restoreOpenSession(), restoreNewSession(), restoreConfigView(), loadConfigs(read(homeTab))])
    return
  }
  // Le worker a supprimé la clé refusée ; le brouillon reste, pour être corrigé sans tout retaper.
  if (result.code === 'unauthorized') {
    // Le formulaire revient avec l'avis.
    set(workspace, { hasKey: false, keyRejected: true, workspaceId: null, organizationName: null })
    return
  }
  throw new Error(result.error)
}

/** Vrai après un premier appui sur `Forget key` : le second appui, confirmé, efface la clé. */
const confirmingForget = atom(false)

async function forgetKey(): Promise<void> {
  set(confirmingForget, false)
  set(workspace, await plugin.request('key.clear'))
  set(sessionRows, null)
  resetConfigs()
}

function KeyForm({ rejected }: { rejected: boolean }) {
  return (
    <Stack gap="sm">
      {rejected ? <Callout tone="danger" title={KEY_REJECTED} /> : null}
      <Callout tone="warning" title="Add your Anthropic API key">
        <Stack gap="sm">
          <Text muted size="sm">
            Orca stores it encrypted in your OS keyring. Only this plugin's worker uses it.
          </Text>
          <Input
            label="API key"
            type="password"
            placeholder="sk-ant-..."
            value={read(keyDraft)}
            onChange={(value) => set(keyDraft, value)}
            onSubmit={() => run(saveKey)}
          />
          <Button onPress={() => run(saveKey)} disabled={!read(keyDraft).trim()}>
            Save key
          </Button>
        </Stack>
      </Callout>
    </Stack>
  )
}

function WorkspaceLine() {
  const info = read(workspace)
  const label = [info?.workspaceId, info?.organizationName].filter(Boolean).join(' · ')
  return (
    <Stack gap="sm">
      <Text>{label || 'Workspace unknown'}</Text>
      <Row gap="sm" wrap>
        {info?.workspaceId ? (
          <Link href={`https://platform.claude.com/workspaces/${info.workspaceId}/agents`}>Console</Link>
        ) : null}
        {read(confirmingForget) ? (
          <>
            <Button variant="solid" tone="danger" size="sm" onPress={() => run(forgetKey)}>
              Confirm forget key
            </Button>
            <Button variant="ghost" size="sm" onPress={() => set(confirmingForget, false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" tone="danger" size="sm" onPress={() => set(confirmingForget, true)}>
            Forget key
          </Button>
        )}
      </Row>
    </Stack>
  )
}

function ConfigList({ tab }: { tab: (typeof CONFIG_TABS)[number] }) {
  const rows = read(configRows)[tab.value]
  const failure = read(configErrors)[tab.value] ?? null
  const query = read(homeFilter)
  const shown = rows ? filterRows(rows, query) : []
  return (
    <Stack gap="sm">
      <Input
        label="Filter"
        labelHidden
        type="search"
        placeholder={`Filter ${tab.noun}`}
        value={query}
        onChange={(value) => set(homeFilter, value)}
      />
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

function ConfigurationsSection() {
  const current = read(homeTab)
  return (
    <Collapsible
      title="Configurations"
      open={read(sectionsOpen).configurations}
      onChange={(next) => update(sectionsOpen, (state) => ({ ...state, configurations: next }))}
    >
      <Stack gap="sm">
        {/* Les `Tabs` d'Orca ne passent jamais à la ligne (coupés dès 312 px) : une rangée de boutons le fait. */}
        <Box direction="row" wrap gap="xs" padding="xs" radius="lg" background="muted">
          {CONFIG_TABS.map((tab) => (
            <Button
              key={tab.value}
              size="sm"
              icon={tab.icon}
              variant={tab.value === current ? 'solid' : 'ghost'}
              // Un bouton plein neutre se fond dans la pastille : l'accent marque le type actif.
              {...(tab.value === current ? { tone: 'accent' as const } : {})}
              onPress={() => {
                set(homeTab, tab.value)
                // Les lignes déjà lues restent affichées pendant la relecture.
                run(() => loadConfigs(tab.value))
              }}
            >
              {tab.label}
            </Button>
          ))}
        </Box>
        {CONFIG_TABS.filter((tab) => tab.value === current).map((tab) => (
          <ConfigList key={tab.value} tab={tab} />
        ))}
      </Stack>
    </Collapsible>
  )
}

function SessionsSection() {
  const loaded = read(sessionRows)
  const rows = sortSessions(loaded ?? [])
  return (
    <Collapsible
      title="Sessions"
      open={read(sectionsOpen).sessions}
      onChange={(next) => update(sectionsOpen, (current) => ({ ...current, sessions: next }))}
    >
      <Stack gap="sm">
        {/* `Collapsible.title` n'accepte qu'une chaîne : le bouton est la première ligne du corps. */}
        <Button icon="add" onPress={openNewSession}>
          New session
        </Button>
        {loaded === null ? (
          <Spinner label="Loading sessions" />
        ) : rows.length === 0 ? (
          <Text muted size="sm">
            No sessions yet.
          </Text>
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
    </Collapsible>
  )
}

export function Home() {
  const info = read(workspace)
  if (!info) {
    return null
  }
  const needsKey = !info.hasKey || info.keyRejected
  // La section est repliée par défaut, mais reste ouverte tant que la clé manque ou est refusée.
  const open = needsKey || read(sectionsOpen).workspace
  return (
    <Stack gap="md">
      <Collapsible
        title="Anthropic workspace"
        open={open}
        onChange={(next) => update(sectionsOpen, (current) => ({ ...current, workspace: next }))}
      >
        {needsKey ? <KeyForm rejected={info.keyRejected} /> : <WorkspaceLine />}
      </Collapsible>
      {needsKey ? null : <ConfigurationsSection />}
      {needsKey ? null : <SessionsSection />}
    </Stack>
  )
}
