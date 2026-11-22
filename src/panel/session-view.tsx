// Vue d'une session : en-tête, détails, fil en direct, accords d'outil et composeur.
// Le worker garde le fil complet ; le panneau n'affiche qu'une fenêtre (`pageWindow`) et la déplace.
import {
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  env,
  Input,
  KeyValue,
  Link,
  Markdown,
  plugin,
  read,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type Disposable
} from 'orca'
import type { ApiResult, ThreadRow, ToolState } from '../protocol'
import { dollarsToMinor, formatMoney } from '../shared/money'
import { badgeLabel, badgeTone } from '../shared/sessions'
import { clipBytes } from '../shared/text'
import { pageWindow } from '../shared/thread-window'
import {
  confirming,
  denyDraft,
  ERROR_TEXT_LIMIT_BYTES,
  draft,
  hasEarlier,
  loadingEarlier,
  mergeRows,
  nav,
  pageEnd,
  popView,
  prependRows,
  previews,
  pushView,
  raiseDraft,
  raiseNotice,
  resetSessionView,
  run,
  sending,
  sessionDetail,
  sessionNotice,
  sessionRows,
  sessionUsage,
  streamState,
  threadLoaded,
  threadRows,
  viewedSession,
  workspace
} from './state'

type ToolRow = Extract<ThreadRow, { kind: 'tool' }>

const TOOL_STATE_LABELS: Record<ToolState, string> = {
  awaiting_approval: 'Waiting for approval',
  allowed: 'Allowed',
  denied: 'Denied',
  running: 'Running',
  done: 'Done',
  error: 'Error'
}

// --- Entrée, sortie et poussées du worker ---

/** Remet la vue à zéro puis lit le fil et les détails en parallèle ; chaque réponse vérifie qu'on regarde encore cette session. */
export async function enterSession(sessionId: string): Promise<void> {
  resetSessionView(sessionId)
  await Promise.all([loadThread(sessionId), loadDetail(sessionId)])
}

async function loadThread(sessionId: string): Promise<void> {
  const result = await plugin.request('session.watch', { sessionId })
  if (read(viewedSession) !== sessionId) return
  set(threadLoaded, true)
  if (!result.ok) {
    set(sessionNotice, result.error)
    return
  }
  // Des poussées ont pu arriver avant la réponse : elles sont plus fraîches, on les garde par-dessus.
  update(threadRows, (current) => mergeRows(result.value.rows, current))
  update(hasEarlier, (current) => current || result.value.hasEarlier)
  update(streamState, (current) => current ?? result.value.stream)
}

async function loadDetail(sessionId: string): Promise<void> {
  const result = await plugin.request('session.detail', { sessionId })
  if (read(viewedSession) !== sessionId) return
  if (!result.ok) {
    set(sessionNotice, result.error)
    return
  }
  set(sessionDetail, result.value)
  // Un `session.updated` arrivé avant cette réponse est plus frais : il garde la main.
  update(sessionUsage, (current) => current ?? { cost: result.value.cost, budget: result.value.budget })
}

/** Ouvre une session depuis une autre vue : empile la vue, puis la charge. */
export function openSession(sessionId: string): void {
  update(nav, (stack) => pushView(stack, { view: 'session', sessionId }))
  run(() => enterSession(sessionId))
}

/** Au redémarrage du panneau, la pile persistée peut avoir une session au sommet : on la rouvre. */
export async function restoreOpenSession(): Promise<void> {
  const top = read(nav).at(-1)
  if (top?.view === 'session') {
    await enterSession(top.sessionId)
  }
}

function goBack(sessionId: string): void {
  run(async () => {
    try {
      await plugin.request('session.leave', { sessionId })
    } finally {
      resetSessionView(null)
      update(nav, popView)
    }
    // Une autre vue de session peut se retrouver au sommet : on la recharge.
    await restoreOpenSession()
  })
}

/** Abonnements du panneau aux poussées du worker ; ils ignorent toute autre session que la vue ouverte. */
export function sessionSubscriptions(): Disposable[] {
  return [
    plugin.on('session.thread', (payload) => {
      if (payload.sessionId !== read(viewedSession)) return
      update(threadRows, (current) => mergeRows(current, payload.rows))
      set(previews, payload.previews)
      if (payload.hasEarlier !== undefined) set(hasEarlier, payload.hasEarlier)
    }),
    plugin.on('stream.state', (state) => {
      if (state.sessionId === read(viewedSession)) set(streamState, state)
    }),
    plugin.on('session.updated', (payload) => {
      if (payload.sessionId === read(viewedSession)) set(sessionUsage, { cost: payload.cost, budget: payload.budget })
    })
  ]
}

// --- Actions ---

/** Lance une action de la session ; un refus d'Orca ou du worker s'affiche près du composeur. */
function act(action: () => Promise<void>): void {
  set(sessionNotice, null)
  action().catch((error: unknown) => set(sessionNotice, error instanceof Error ? error.message : String(error)))
}

/** Lit une réponse de l'API : son erreur, brute, devient l'avis de la session. */
function unwrapHere<T>(result: ApiResult<T>): T | null {
  if (result.ok) return result.value
  set(sessionNotice, result.error)
  return null
}

async function sendMessage(sessionId: string): Promise<void> {
  const text = read(draft).trim()
  // Un envoi déjà en route : un second Cmd+Enter enverrait le message deux fois à une session facturée.
  if (!text || read(sending)) return
  set(sending, true)
  try {
    const result = await plugin.request('session.send', { sessionId, text })
    if (!result.ok) {
      set(sessionNotice, result.error)
      return
    }
    // Si la saisie a changé pendant l'envoi, on ne l'écrase pas.
    if (read(draft).trim() === text) set(draft, '')
  } finally {
    set(sending, false)
  }
}

async function interrupt(sessionId: string): Promise<void> {
  const result = await plugin.request('session.interrupt', { sessionId })
  if (!result.ok) set(sessionNotice, result.error)
}

async function confirmTool(sessionId: string, toolUseId: string, allow: boolean): Promise<void> {
  if (read(confirming).includes(toolUseId)) return
  update(confirming, (current) => [...current, toolUseId])
  try {
    const reason = (read(denyDraft)[toolUseId] ?? '').trim()
    const result = await plugin.request('session.confirm', {
      sessionId,
      toolUseId,
      allow,
      denyMessage: allow ? null : reason || null
    })
    if (result.ok) {
      // Le worker confirmera par une poussée ; en attendant, la ligne ne propose plus d'accord.
      update(threadRows, (rows) =>
        rows.map((row) =>
          row.kind === 'tool' && row.id === toolUseId
            ? { ...row, needsConfirmation: false, state: allow ? 'allowed' : 'denied' }
            : row
        )
      )
    } else {
      set(sessionNotice, result.error)
    }
  } finally {
    update(confirming, (current) => current.filter((id) => id !== toolUseId))
  }
}

async function raiseBudget(sessionId: string): Promise<void> {
  const dollars = read(raiseDraft).trim()
  set(raiseNotice, null)
  if (dollarsToMinor(dollars) === null) {
    set(raiseNotice, 'The budget must be a positive amount in dollars, with at most two decimals.')
    return
  }
  const result = await plugin.request('session.raiseBudget', { sessionId, dollars })
  if (!result.ok) {
    set(raiseNotice, result.error)
    return
  }
  set(sessionDetail, result.value)
  set(sessionUsage, { cost: result.value.cost, budget: result.value.budget })
  set(raiseDraft, '')
}

/** Descend d'une page : sur les lignes déjà chargées, ou chez le worker quand elles sont épuisées. */
async function loadEarlier(sessionId: string, firstIndex: number): Promise<void> {
  if (firstIndex > 0) {
    set(pageEnd, firstIndex)
    return
  }
  const oldest = read(threadRows)[0]
  if (!oldest || read(loadingEarlier)) return
  set(loadingEarlier, true)
  try {
    const result = await plugin.request('session.loadEarlier', { sessionId, beforeId: oldest.id })
    if (read(viewedSession) !== sessionId) return
    const page = unwrapHere(result)
    if (!page) return
    const merged = prependRows(read(threadRows), page.rows)
    set(threadRows, merged.rows)
    set(hasEarlier, page.hasEarlier)
    // Les lignes ajoutées en tête décalent tout : la page affichée est celle qui se termine juste avant l'ancien début.
    if (merged.added > 0) set(pageEnd, merged.added)
  } finally {
    set(loadingEarlier, false)
  }
}

// --- Rendu ---

function formatCreated(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString(env.locale, { dateStyle: 'medium', timeStyle: 'short' })
}

function Header({ sessionId }: { sessionId: string }) {
  const row = read(sessionRows)?.find((candidate) => candidate.id === sessionId) ?? null
  const detail = read(sessionDetail)
  // Le badge vient de la liste des sessions (le sondeur du worker) ; `session.detail` ne sert qu'avant sa première poussée.
  const badge = row?.badge ?? detail?.badge ?? null
  const money = read(sessionUsage) ?? (row ? { cost: row.cost, budget: row.budget } : null)
  const title = row?.title ?? detail?.title ?? sessionId
  const cost = money?.budget ? `${formatMoney(money.cost) || '$0.00'} / ${formatMoney(money.budget)}` : formatMoney(money?.cost ?? null)
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" justify="between" wrap>
        <Button variant="ghost" size="sm" onPress={() => goBack(sessionId)}>
          ‹ Back
        </Button>
        {badge ? <Badge tone={badgeTone(badge)}>{badgeLabel(badge)}</Badge> : null}
      </Row>
      <Stack gap="xs">
        <Text weight="semibold">{title}</Text>
        {cost ? (
          <Text muted size="sm">
            {cost}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  )
}

function RaiseBudget({ sessionId }: { sessionId: string }) {
  const draftValue = read(raiseDraft)
  const failure = read(raiseNotice)
  return (
    <Stack gap="sm">
      <Input
        label="New budget limit ($)"
        placeholder="e.g. 5.00"
        value={draftValue}
        invalid={failure !== null}
        onChange={(value) => set(raiseDraft, value)}
        onSubmit={() => run(() => raiseBudget(sessionId))}
      />
      {failure ? (
        <Text tone="danger" size="sm">
          {failure}
        </Text>
      ) : null}
      <Row>
        <Button size="sm" disabled={!draftValue.trim()} onPress={() => run(() => raiseBudget(sessionId))}>
          Raise budget
        </Button>
      </Row>
    </Stack>
  )
}

function Details({ sessionId, budgetReached }: { sessionId: string; budgetReached: boolean }) {
  const detail = read(sessionDetail)
  const workspaceId = read(workspace)?.workspaceId ?? null
  const hasBudget = (read(sessionUsage)?.budget ?? detail?.budget ?? null) !== null
  return (
    <Collapsible title="Details">
      {detail === null ? (
        <Spinner label="Loading details" />
      ) : (
        <Stack gap="sm">
          <KeyValue
            label="Session details"
            items={[
              { label: 'Agent', value: `${detail.agentName} v${detail.agentVersion}` },
              { label: 'Environment', value: detail.environmentName ?? detail.environmentId },
              { label: 'Vaults', value: detail.vaultIds.length > 0 ? detail.vaultIds.join(', ') : 'None', code: detail.vaultIds.length > 0 },
              { label: 'Resources', value: detail.resources.length > 0 ? detail.resources.join('; ') : 'None' },
              { label: 'Created', value: formatCreated(detail.createdAt) }
            ]}
          />
          {workspaceId ? (
            <Link href={`https://platform.claude.com/workspaces/${workspaceId}/sessions/${sessionId}`}>Open in Console ↗</Link>
          ) : null}
          {/* Sur `Budget reached`, le formulaire est déjà au-dessus du fil : un seul champ à la fois. */}
          {hasBudget && !budgetReached ? <RaiseBudget sessionId={sessionId} /> : null}
        </Stack>
      )}
    </Collapsible>
  )
}

function StreamLine() {
  const state = read(streamState)
  if (!state || (state.phase === 'open' && !state.error)) return null
  if (state.phase === 'connecting') {
    return (
      <Text muted size="xs">
        Connecting...
      </Text>
    )
  }
  const lead = state.phase === 'reconnecting' ? `Reconnecting (${state.reconnects})...` : state.phase === 'closed' ? 'Stream closed.' : ''
  return (
    <Text tone={state.phase === 'closed' ? 'danger' : 'warning'} size="xs">
      {[lead, state.error].filter(Boolean).join(' ')}
    </Text>
  )
}

function Truncated() {
  return (
    <Text muted size="xs">
      Truncated
    </Text>
  )
}

function MessageRow({ row }: { row: Extract<ThreadRow, { kind: 'user_message' | 'agent_message' }> }) {
  const mine = row.kind === 'user_message'
  const body = (
    <Stack gap="xs">
      <Text size="xs" weight="semibold" {...(mine ? { muted: true } : { tone: 'accent' as const })}>
        {mine ? 'You' : 'Agent'}
      </Text>
      {row.text.text ? <Markdown content={row.text.text} /> : null}
      {row.text.truncated ? <Truncated /> : null}
    </Stack>
  )
  return mine ? (
    <Box background="muted" radius="md" padding="sm">
      {body}
    </Box>
  ) : (
    body
  )
}

function ToolIo({ label, text, truncated, language }: { label: string; text: string; truncated: boolean; language?: string }) {
  if (!text) return null
  return (
    <Stack gap="xs">
      <Text muted size="xs" weight="medium">
        {label}
      </Text>
      <CodeView code={text} label={label} wrap maxHeight="sm" {...(language ? { language } : {})} />
      {truncated ? <Truncated /> : null}
    </Stack>
  )
}

function Approval({ sessionId, row }: { sessionId: string; row: ToolRow }) {
  const busy = read(confirming).includes(row.id)
  const reason = read(denyDraft)[row.id] ?? ''
  return (
    <Callout tone="warning" title="Approval needed">
      <Stack gap="sm">
        {row.input.text ? <CodeView code={row.input.text} label="Tool input" language="json" wrap maxHeight="sm" /> : null}
        <Input
          label="Deny reason (optional)"
          value={reason}
          onChange={(value) => update(denyDraft, (current) => ({ ...current, [row.id]: value }))}
        />
        <Row gap="sm" wrap>
          <Button disabled={busy} onPress={() => act(() => confirmTool(sessionId, row.id, true))}>
            Allow
          </Button>
          <Button variant="outline" tone="danger" disabled={busy} onPress={() => act(() => confirmTool(sessionId, row.id, false))}>
            Deny
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function ToolCall({ sessionId, row }: { sessionId: string; row: ToolRow }) {
  return (
    <Stack gap="xs">
      <Collapsible title={`${row.server ? `${row.server}.` : ''}${row.name}`} description={TOOL_STATE_LABELS[row.state]}>
        <Stack gap="sm">
          <ToolIo label="Input" text={row.input.text} truncated={row.input.truncated} language="json" />
          {row.result ? <ToolIo label="Result" text={row.result.text} truncated={row.result.truncated} /> : null}
          {!row.input.text && !row.result?.text ? (
            <Text muted size="sm">
              No input or result.
            </Text>
          ) : null}
        </Stack>
      </Collapsible>
      {/* Hors du Collapsible : les contrôles d'un Collapsible fermé ne sont ni visibles ni trouvables. */}
      {row.needsConfirmation ? <Approval sessionId={sessionId} row={row} /> : null}
    </Stack>
  )
}

function Line({ sessionId, row }: { sessionId: string; row: ThreadRow }) {
  switch (row.kind) {
    case 'user_message':
    case 'agent_message':
      return <MessageRow row={row} />
    case 'tool':
      return <ToolCall sessionId={sessionId} row={row} />
    case 'status':
      return (
        <Text size="sm" {...(row.tone === 'neutral' ? { muted: true } : { tone: row.tone })}>
          {row.text}
        </Text>
      )
  }
}

function Thread({ sessionId }: { sessionId: string }) {
  const rows = read(threadRows)
  const end = read(pageEnd)
  const { visible, firstIndex } = pageWindow(rows, end)
  const live = read(previews)
  if (!read(threadLoaded)) return <Spinner label="Loading thread" />
  return (
    <Stack gap="md">
      {read(hasEarlier) || firstIndex > 0 || end !== null ? (
        <Row gap="sm" wrap>
          {read(hasEarlier) || firstIndex > 0 ? (
            <Button variant="outline" size="sm" disabled={read(loadingEarlier)} onPress={() => act(() => loadEarlier(sessionId, firstIndex))}>
              Load earlier
            </Button>
          ) : null}
          {end !== null ? (
            <Button variant="outline" size="sm" onPress={() => set(pageEnd, null)}>
              Latest
            </Button>
          ) : null}
        </Row>
      ) : null}
      {rows.length === 0 && live.length === 0 ? (
        <Text muted size="sm">
          No messages yet.
        </Text>
      ) : null}
      {visible.map((row) => (
        <Line key={row.id} sessionId={sessionId} row={row} />
      ))}
      {/* Les aperçus appartiennent à la fin du fil : on les cache quand on lit une page plus ancienne. */}
      {end === null
        ? live.map((preview) => (
            <Stack gap="xs" key={`preview-${preview.id}`}>
              <Text size="xs" weight="semibold" tone="accent">
                Agent
              </Text>
              <Markdown content={preview.text || '...'} />
            </Stack>
          ))
        : null}
    </Stack>
  )
}

/** Erreur brute de l'API : le titre reste un libellé fixe, le texte va en enfant (un libellé de plus de 1 Kio fait refuser le rendu). */
function ErrorCallout({ message }: { message: string }) {
  return (
    <Callout tone="danger" title="Action failed">
      <Text size="sm">{clipBytes(message, ERROR_TEXT_LIMIT_BYTES).text}</Text>
    </Callout>
  )
}

function Composer({ sessionId, running, terminated }: { sessionId: string; running: boolean; terminated: boolean }) {
  const notice = read(sessionNotice)
  const text = read(draft)
  return (
    <Stack gap="sm">
      {notice ? <ErrorCallout message={notice} /> : null}
      {terminated ? (
        <Text muted size="sm">
          This session has ended.
        </Text>
      ) : (
        <Stack gap="sm">
          <Textarea
            label="Message"
            labelHidden
            placeholder="Message the agent (Cmd+Enter sends)"
            rows={3}
            value={text}
            onChange={(value) => set(draft, value)}
            onSubmit={() => act(() => sendMessage(sessionId))}
          />
          <Row gap="sm" wrap>
            <Button disabled={!text.trim() || read(sending)} onPress={() => act(() => sendMessage(sessionId))}>
              Send
            </Button>
            <Button variant="outline" tone="danger" icon="stop" disabled={!running} onPress={() => act(() => interrupt(sessionId))}>
              Interrupt
            </Button>
          </Row>
        </Stack>
      )}
    </Stack>
  )
}

export function SessionView({ sessionId }: { sessionId: string }) {
  const row = read(sessionRows)?.find((candidate) => candidate.id === sessionId) ?? null
  const detail = read(sessionDetail)
  const status = row?.status ?? detail?.status ?? null
  const badge = row?.badge ?? detail?.badge ?? null
  const budgetReached = badge === 'budget_reached'
  return (
    <Stack gap="md">
      <Header sessionId={sessionId} />
      {budgetReached ? (
        <Callout tone="danger" title="Budget reached">
          <Stack gap="sm">
            <Text size="sm">The session stopped at its budget limit. Raise it to let the agent continue.</Text>
            <RaiseBudget sessionId={sessionId} />
          </Stack>
        </Callout>
      ) : null}
      <Details sessionId={sessionId} budgetReached={budgetReached} />
      <StreamLine />
      <Separator />
      <Thread sessionId={sessionId} />
      <Separator />
      <Composer sessionId={sessionId} running={status === 'running'} terminated={status === 'terminated'} />
    </Stack>
  )
}
