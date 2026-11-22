// Panneau de la sonde : aucun réseau ici, tout passe par le worker (`plugin.request`), qui
// pousse en retour l'état du flux et les événements de la session suivie (`plugin.on`).
import {
  atom,
  Badge,
  Button,
  Callout,
  Code,
  Collapsible,
  Heading,
  IconButton,
  Input,
  List,
  ListItem,
  Markdown,
  plugin,
  read,
  RelativeTime,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type PanelContext,
  type Tone
} from 'orca'
import {
  ROW_LIMIT,
  type AgentRow,
  type ApiResult,
  type EventRow,
  type Preview,
  type ProbeStatus,
  type SessionRow,
  type StreamState
} from './protocol'

const status = atom<ProbeStatus | null>(null)
const keyDraft = atom('')
const agents = atom<AgentRow[]>([])
const sessions = atom<SessionRow[]>([])
const notice = atom<string | null>(null)
const followed = atom<string | null>(null)
const stream = atom<StreamState | null>(null)
const rows = atom<EventRow[]>([])
const previews = atom<Preview[]>([])
const draft = atom('')

/** Remplace les lignes déjà connues, ajoute les autres, garde la fin du fil. */
function merge(current: EventRow[], incoming: EventRow[]): EventRow[] {
  const next = [...current]
  for (const row of incoming) {
    const index = next.findIndex((known) => known.id === row.id)
    if (index >= 0) {
      next[index] = row
    } else {
      next.push(row)
    }
  }
  return next.slice(-ROW_LIMIT)
}

/** Lit une réponse de l'API : son erreur devient l'avis affiché en haut du panneau. */
function unwrap<T>(result: ApiResult<T>): T | null {
  if (result.ok) {
    return result.value
  }
  set(notice, result.error)
  return null
}

/** Lance une action du panneau ; un refus d'Orca ou du worker s'affiche au lieu de se perdre. */
function run(action: () => Promise<void>): void {
  set(notice, null)
  action().catch((error: unknown) => set(notice, error instanceof Error ? error.message : String(error)))
}

async function follow(sessionId: string): Promise<void> {
  set(followed, sessionId)
  set(rows, [])
  set(previews, [])
  set(stream, null)
  const answer = unwrap(await plugin.request('session.watch', { sessionId }))
  if (answer) {
    set(stream, answer.stream)
    // Des événements poussés ont pu arriver avant la réponse : on fusionne, on n'écrase pas.
    update(rows, (current) => merge(answer.rows, current))
  }
}

async function refresh(): Promise<void> {
  const current = await plugin.request('probe.status')
  set(status, current)
  if (!current.hasKey) {
    return
  }
  const [agentList, sessionList] = await Promise.all([
    plugin.request('agents.list'),
    plugin.request('sessions.list')
  ])
  set(agents, unwrap(agentList) ?? [])
  set(sessions, unwrap(sessionList) ?? [])
  if (current.stream) {
    await follow(current.stream.sessionId)
  } else if (read(followed)) {
    // Le worker ne suit plus rien alors que le panneau si : il a redémarré et perdu le flux.
    set(stream, null)
    set(notice, 'The worker restarted: the live stream was lost. Pick the session again.')
  }
}

async function saveKey(): Promise<void> {
  set(status, await plugin.request('key.set', { key: read(keyDraft) }))
  set(keyDraft, '')
  await refresh()
}

async function forgetKey(): Promise<void> {
  set(status, await plugin.request('key.clear'))
  set(followed, null)
  set(stream, null)
  set(rows, [])
  set(previews, [])
}

async function send(): Promise<void> {
  const sessionId = read(followed)
  const text = read(draft).trim()
  if (!sessionId || !text) {
    return
  }
  const result = await plugin.request('session.send', { sessionId, text })
  if (result.ok) {
    set(draft, '')
  } else {
    set(notice, result.error)
  }
}

async function confirm(toolUseId: string, allow: boolean): Promise<void> {
  const sessionId = read(followed)
  if (sessionId) {
    unwrap(await plugin.request('session.confirm', { sessionId, toolUseId, allow }))
  }
}

async function interrupt(): Promise<void> {
  const sessionId = read(followed)
  if (sessionId) {
    unwrap(await plugin.request('session.interrupt', { sessionId }))
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('stream.state', (state) => {
      if (state.sessionId === read(followed)) {
        set(stream, state)
      }
    }),
    plugin.on('session.events', (payload) => {
      if (payload.sessionId !== read(followed)) {
        return
      }
      update(rows, (current) => merge(current, payload.rows))
      set(previews, payload.previews)
    })
  )
  run(refresh)
}

function toneOf(type: string): Tone {
  if (type === 'session.error') {
    return 'danger'
  }
  if (type === 'session.status_idle') {
    return 'success'
  }
  return type.startsWith('agent.') ? 'accent' : 'neutral'
}

const PHASE_TONE: Record<StreamState['phase'], Tone> = {
  connecting: 'neutral',
  open: 'success',
  reconnecting: 'warning',
  closed: 'danger'
}

function KeyForm() {
  return (
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
  )
}

function EventLine({ row, answered }: { row: EventRow; answered: boolean }) {
  const waiting = row.awaitsApproval && !answered
  // `at` vient de l'API : une date illisible ne doit pas faire refuser tout le rendu.
  const at = row.at ? Date.parse(row.at) : Number.NaN
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        <Badge tone={waiting ? 'warning' : toneOf(row.type)}>{row.type}</Badge>
        {Number.isFinite(at) ? (
          <Text muted size="xs">
            <RelativeTime at={at} format="short" />
          </Text>
        ) : (
          <Text muted size="xs">
            queued
          </Text>
        )}
      </Row>
      {row.type === 'agent.message' && row.text ? <Markdown content={row.text} /> : null}
      {row.type !== 'agent.message' && row.text ? <Code block>{row.text}</Code> : null}
      {waiting ? (
        <Row gap="xs">
          <Button size="sm" tone="success" onPress={() => run(() => confirm(row.id, true))}>
            Allow
          </Button>
          <Button size="sm" variant="outline" tone="danger" onPress={() => run(() => confirm(row.id, false))}>
            Deny
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

function SessionView({ sessionId }: { sessionId: string }) {
  const state = read(stream)
  const list = read(rows)
  const answered = new Set(list.map((row) => row.answers))
  return (
    <Stack gap="sm">
      <Row gap="xs" wrap>
        <Badge tone={state ? PHASE_TONE[state.phase] : 'neutral'}>stream: {state?.phase ?? 'off'}</Badge>
        {state ? (
          <Text muted size="xs">
            for <RelativeTime at={state.since} format="duration" />
          </Text>
        ) : null}
        {state && state.reconnects > 0 ? <Badge tone="warning">reconnects: {state.reconnects}</Badge> : null}
      </Row>
      {state?.error ? <Text tone="danger">{state.error}</Text> : null}
      <Textarea
        label="Message"
        labelHidden
        placeholder="Message the agent (Cmd+Enter sends)"
        rows={3}
        value={read(draft)}
        onChange={(value) => set(draft, value)}
        onSubmit={() => run(send)}
      />
      <Row gap="xs">
        <Button icon="play" onPress={() => run(send)} disabled={!read(draft).trim()}>
          Send
        </Button>
        <Button variant="ghost" icon="stop" onPress={() => run(interrupt)}>
          Interrupt
        </Button>
      </Row>
      <Text muted size="xs">
        {list.length} events of {sessionId}, newest first
      </Text>
      {read(previews).map((preview) => (
        <Stack gap="xs" key={`preview-${preview.id}`}>
          <Badge tone="accent">writing</Badge>
          <Markdown content={preview.text || '...'} />
        </Stack>
      ))}
      {[...list].reverse().map((row) => (
        <EventLine key={row.id} row={row} answered={answered.has(row.id)} />
      ))}
    </Stack>
  )
}

export default function Panel() {
  const current = read(status)
  const sessionId = read(followed)
  const error = read(notice)
  if (!current) {
    return error ? <Callout tone="danger" title={error} /> : <Spinner label="Loading" />
  }
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Managed Agents</Heading>
        <Row gap="xs">
          <Text muted size="xs">
            worker up <RelativeTime at={current.workerStartedAt} format="duration" />
          </Text>
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={() => run(refresh)} />
        </Row>
      </Row>
      {error ? <Callout tone="danger" title={error} /> : null}
      {current.hasKey ? (
        <Stack gap="md">
          <Collapsible title={`Agents (${read(agents).length})`} defaultOpen>
            <List label="Agents">
              {read(agents).map((agent) => (
                <ListItem
                  key={agent.id}
                  icon="bot"
                  title={agent.name}
                  description={`${agent.model} · v${agent.version}`}
                />
              ))}
            </List>
          </Collapsible>
          <Select
            label="Session"
            placeholder="Pick a session to follow"
            {...(sessionId ? { value: sessionId } : {})}
            options={read(sessions).map((session) => ({
              value: session.id,
              label: `${session.title ?? session.id} · ${session.agentName} · ${session.status}`
            }))}
            onChange={(id) => run(() => follow(id))}
          />
          {sessionId ? <SessionView sessionId={sessionId} /> : null}
          <Button variant="ghost" tone="danger" onPress={() => run(forgetKey)}>
            Forget API key
          </Button>
        </Stack>
      ) : (
        <KeyForm />
      )}
    </Stack>
  )
}
