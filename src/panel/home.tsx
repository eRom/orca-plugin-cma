// Accueil du panneau : les sections « Anthropic workspace » (clé et identité) et « Sessions ».
// La section Configurations arrive avec une tâche suivante.
import {
  atom,
  Badge,
  Button,
  Callout,
  Collapsible,
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
  update
} from 'orca'
import { formatMoney } from '../shared/money'
import { badgeLabel, badgeTone, sortSessions } from '../shared/sessions'
import { loadSessions, nav, pushView, run, sectionsOpen, sessionRows, workspace } from './state'

const keyDraft = atom('')
const KEY_REJECTED = 'The API key was rejected (401).'

async function saveKey(): Promise<void> {
  const result = await plugin.request('key.set', { key: read(keyDraft).trim() })
  if (result.ok) {
    set(keyDraft, '')
    set(workspace, result.value)
    // Les sessions de l'ancienne clé ne valent plus rien : on relit celles de la nouvelle.
    set(sessionRows, null)
    await loadSessions()
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

async function forgetKey(): Promise<void> {
  set(workspace, await plugin.request('key.clear'))
  set(sessionRows, null)
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
        <Button variant="ghost" tone="danger" size="sm" onPress={() => run(forgetKey)}>
          Forget key
        </Button>
      </Row>
    </Stack>
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
        <Button icon="add" onPress={() => update(nav, (stack) => pushView(stack, { view: 'newSession' }))}>
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
                title={row.title ?? row.id}
                description={[row.agentName, formatMoney(row.cost)].filter(Boolean).join(' · ')}
                onPress={() => update(nav, (stack) => pushView(stack, { view: 'session', sessionId: row.id }))}
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
      {needsKey ? null : <SessionsSection />}
    </Stack>
  )
}
