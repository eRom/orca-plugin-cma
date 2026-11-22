// Contrôles d'un brouillon : installation du dossier, ouverture dans l'éditeur d'Orca, application
// (récapitulatif puis envoi), conflit et succès. Tout l'état est éphémère (rien n'est persisté, le jeton
// d'écriture non plus) et rangé par `draftKey(ref)` : deux brouillons ne se mélangent pas.
//
// Un composant d'Orca ne peut pas lancer de lecture en se dessinant : la vue qui héberge `DraftControls`
// appelle `loadDraftControls(draftRef)` à son ouverture (`run(() => loadDraftControls(ref))`).
import {
  atom,
  Button,
  Callout,
  CodeView,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update,
  type OrcaNode,
  type PanelContext
} from 'orca'
import type { ApiErrorCode, DraftInfo, DraftRef, DraftsStatus, PreparedWrite } from '../protocol'
import { clipBytes } from '../shared/text'
import { ChangesPreview } from './changes'
import { ConfirmAction } from './confirm'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, run } from './state'

/** Relecture de `drafts.status` tant que la carte d'installation est affichée. */
export const DRAFTS_POLL_MS = 5_000
/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafond d'un titre ou d'un nom repris dans un libellé : plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200

// --- Clé ---

/** Clé de l'état d'un brouillon : le genre et l'identité, `new` pour un objet pas encore créé. Stable : les vues s'y fient. */
export function draftKey(ref: DraftRef): string {
  return ref.kind === 'agent' ? `agent:${ref.agentId ?? 'new'}` : `memory:${ref.memoryStoreId}:${ref.memoryId ?? `new:${ref.path}`}`
}

// --- État éphémère ---

type Notice = { tone: 'warning' | 'danger'; title: string; message: string }

/** Où en est un brouillon. Absent : au repos. `busy` : un envoi est en route, les boutons sont grisés. */
type Flow =
  | { step: 'opening' }
  | { step: 'preparing' }
  | { step: 'review'; prepared: PreparedWrite; busy: boolean; error: string | null }
  | { step: 'conflict'; prepared: PreparedWrite; busy: boolean; message: string }
  | { step: 'applied'; label: string; returnTo: DraftInfo['returnTo'] }
  | { step: 'notice'; notice: Notice }

/** Le dossier de brouillons et s'il est un projet d'Orca ; null tant que la première lecture n'est pas revenue. */
const draftsStatus = atom<DraftsStatus | null>(null)
/** Vrai pendant un « Check again ». */
const checking = atom(false)
/** Le brouillon que le worker connaît, par clé ; absent tant que `draft.state` n'a pas répondu, null s'il n'y en a pas. */
const draftInfos = atom<Record<string, DraftInfo | null>>({})
const draftFlows = atom<Record<string, Flow>>({})
/** Brouillons ouverts depuis ce panneau : Apply reste proposé même si le fichier n'a pas encore été sauvegardé. */
const draftOpened = atom<Record<string, true>>({})

function setFlow(key: string, flow: Flow | null): void {
  update(draftFlows, (flows) => {
    const next = { ...flows }
    if (flow === null) delete next[key]
    else next[key] = flow
    return next
  })
}

function setInfo(key: string, info: DraftInfo | null): void {
  update(draftInfos, (infos) => ({ ...infos, [key]: info }))
}

function setOpened(key: string, opened: boolean): void {
  update(draftOpened, (current) => {
    const next = { ...current }
    if (opened) next[key] = true
    else delete next[key]
    return next
  })
}

/** Vrai quand un appel est en vol pour ce brouillon : aucun second ne part. */
function isBusy(flow: Flow | undefined): boolean {
  return flow?.step === 'opening' || flow?.step === 'preparing' || ((flow?.step === 'review' || flow?.step === 'conflict') && flow.busy)
}

// --- Relecture de l'état d'installation ---

let pollMs = DRAFTS_POLL_MS
let pollTimer: ReturnType<typeof setInterval> | null = null
/** Vrai entre `setupDrafts` et la fermeture du panneau : sans lui, une réponse tardive relancerait un minuteur orphelin. */
let panelOpen = false
/** Numéro de la dernière relecture lancée : une réponse plus ancienne que la dernière ne compte pas. */
let statusSeq = 0

/** Intervalle de relecture ; les tests le raccourcissent, avant de monter le panneau. */
export function setDraftsPollInterval(ms: number): void {
  pollMs = ms
}

function stopPoll(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function startPoll(): void {
  if (!panelOpen || pollTimer !== null) return
  pollTimer = setInterval(() => {
    // Une relecture perdue coûte un tour : la suivante, ou « Check again », reprend.
    refreshDraftsStatus().catch(() => {})
  }, pollMs)
}

/** À appeler depuis le `setup` du panneau : la relecture s'arrête à la fermeture, quoi qu'affiche la vue. */
export function setupDrafts(ctx: PanelContext): void {
  panelOpen = true
  ctx.signal.addEventListener('abort', () => {
    panelOpen = false
    stopPoll()
  })
}

/** Relit `drafts.status`. Tant que le dossier n'est pas un projet, la relecture se répète ; elle s'arrête dès qu'il l'est. */
export async function refreshDraftsStatus(): Promise<void> {
  const mine = ++statusSeq
  const status = await plugin.request('drafts.status')
  if (mine !== statusSeq) return
  set(draftsStatus, status)
  if (status.ready) stopPoll()
  else startPoll()
}

/** Relit ce que le worker sait du brouillon (le registre seul répond, sans réseau). */
export async function refreshDraftState(ref: DraftRef): Promise<void> {
  const result = await plugin.request('draft.state', ref)
  if (result.ok) setInfo(draftKey(ref), result.value)
}

/**
 * Lit l'état d'installation et le brouillon : à appeler à l'ouverture de la vue qui rend `DraftControls`.
 * Ces deux lectures sont de fond : un échec laisse l'état inconnu, et chaque action affiche son propre refus.
 */
export async function loadDraftControls(ref: DraftRef): Promise<void> {
  await Promise.all([refreshDraftsStatus().catch(() => {}), refreshDraftState(ref).catch(() => {})])
}

// --- Actions ---

const clipTitle = (text: string): string => clipBytes(text, TITLE_LIMIT_BYTES).text

type Failure = { code: ApiErrorCode; error: string }

/** Les refus qui se corrigent par un geste de la personne s'affichent en avertissement, les autres en erreur. */
const WARNING_CODES: readonly ApiErrorCode[] = ['nothing_to_apply', 'expired', 'invalid', 'drafts_missing']

function noticeOf(failure: Failure, warningTitle: string, dangerTitle: string): Notice {
  const warning = WARNING_CODES.includes(failure.code)
  return {
    tone: warning ? 'warning' : 'danger',
    title: warning ? warningTitle : dangerTitle,
    message: clipBytes(failure.error, ERROR_TEXT_LIMIT_BYTES).text
  }
}

/** Montre le refus d'un appel ; une clé refusée relit l'identité du workspace, un dossier absent relit son état. */
async function showFailure(key: string, failure: Failure, warningTitle: string, dangerTitle: string): Promise<void> {
  if (failure.code === 'unauthorized') {
    setFlow(key, null)
    await loadWorkspace()
    return
  }
  setFlow(key, { step: 'notice', notice: noticeOf(failure, warningTitle, dangerTitle) })
  if (failure.code === 'drafts_missing') await refreshDraftsStatus().catch(() => {})
}

async function openDraft(ref: DraftRef): Promise<void> {
  const key = draftKey(ref)
  if (isBusy(read(draftFlows)[key])) return
  setFlow(key, { step: 'opening' })
  try {
    const result = await plugin.request('draft.open', ref)
    if (!result.ok) return await showFailure(key, result, 'Could not open the draft', 'Could not open the draft')
    setInfo(key, result.value)
    setOpened(key, true)
    setFlow(key, null)
  } catch (error) {
    setFlow(key, null)
    throw error
  }
}

async function applyDraft(ref: DraftRef): Promise<void> {
  const key = draftKey(ref)
  if (isBusy(read(draftFlows)[key])) return
  setFlow(key, { step: 'preparing' })
  try {
    const result = await plugin.request('draft.prepare', ref)
    if (!result.ok) return await showFailure(key, result, 'Not applied', 'Could not apply')
    setFlow(key, { step: 'review', prepared: result.value, busy: false, error: null })
  } catch (error) {
    setFlow(key, null)
    throw error
  }
}

/** Envoie l'écriture en attente. Un conflit rouvre le choix, un refus du récapitulatif le ferme, tout autre échec garde le jeton. */
async function commitDraft(ref: DraftRef, force: boolean, onApplied?: () => void): Promise<void> {
  const key = draftKey(ref)
  const flow = read(draftFlows)[key]
  // Le worker partage le résultat d'un envoi en vol : un second appui, forcé ou non, ne ferait que rejouer le premier.
  if ((flow?.step !== 'review' && flow?.step !== 'conflict') || flow.busy) return
  const { prepared } = flow
  const returnTo = read(draftInfos)[key]?.returnTo ?? null
  setFlow(key, { ...flow, busy: true })
  let result
  try {
    result = await plugin.request('write.commit', { token: prepared.token, force })
  } catch (error) {
    setFlow(key, { ...flow, busy: false })
    throw error
  }
  if (result.ok) {
    setFlow(key, { step: 'applied', label: result.value.label, returnTo })
    // La vue relit l'objet écrit (rien d'autre ne le fait) : le rappel part dès que le succès est affiché.
    onApplied?.()
    await refreshDraftState(ref).catch(() => {})
    return
  }
  switch (result.code) {
    case 'conflict':
      setFlow(key, { step: 'conflict', prepared, busy: false, message: clipTitle(result.error || CONFLICT_TITLE) })
      return
    case 'unauthorized':
    case 'expired':
    case 'nothing_to_apply':
    case 'invalid':
      await showFailure(key, result, 'Not applied', 'Could not apply')
      return
    default:
      setFlow(key, { step: 'review', prepared, busy: false, error: clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text })
  }
}

/** Remet le fichier à l'état de l'objet vivant : le brouillon n'est plus « non appliqué ». */
async function resetDraft(ref: DraftRef): Promise<void> {
  const key = draftKey(ref)
  const result = await plugin.request('draft.discard', ref)
  if (!result.ok) throw new Error(result.error)
  setInfo(key, result.value)
  setOpened(key, false)
  setFlow(key, null)
}

/** « Reload » d'un conflit : abandonne le brouillon pour repartir de l'objet vivant. */
async function reloadDraft(ref: DraftRef): Promise<void> {
  const key = draftKey(ref)
  const flow = read(draftFlows)[key]
  if (flow?.step !== 'conflict' || flow.busy) return
  setFlow(key, { ...flow, busy: true })
  try {
    await resetDraft(ref)
  } catch (error) {
    setFlow(key, { ...flow, busy: false })
    throw error
  }
}

function finish(ref: DraftRef): void {
  const key = draftKey(ref)
  setFlow(key, null)
  setOpened(key, false)
  run(() => refreshDraftState(ref))
}

function goBack(workspaceId: string): void {
  run(async () => {
    const result = await plugin.request('workspace.back', { workspaceId })
    if (!result.ok) throw new Error(result.error)
  })
}

// --- Rendu ---

/** `HH:MM` à l'heure locale ; null si la date n'est pas lisible. */
function clock(iso: string): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function SetupCard({ folder }: { folder: string }): OrcaNode {
  const busy = read(checking)
  return (
    <Callout tone="accent" title="Add the drafts folder to Orca">
      <Stack gap="sm">
        <Text size="sm">Orca opens drafts from a project folder. Add this folder once (Add project, then Folder), then come back:</Text>
        <CodeView code={clipBytes(folder, 2_000).text} label="Drafts folder" wrap />
        <Row gap="sm" wrap>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() =>
              run(async () => {
                set(checking, true)
                try {
                  await refreshDraftsStatus()
                } finally {
                  set(checking, false)
                }
              })
            }
          >
            Check again
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function FlowView({ draftRef, flow, onApplied }: { draftRef: DraftRef; flow: Flow; onApplied: (() => void) | undefined }): OrcaNode {
  const key = draftKey(draftRef)
  switch (flow.step) {
    case 'review':
      return (
        <Stack gap="sm">
          {flow.error !== null ? (
            <Callout tone="danger" title="Could not apply">
              <Text size="sm">{flow.error}</Text>
            </Callout>
          ) : null}
          <ChangesPreview
            prepared={flow.prepared}
            busy={flow.busy}
            onConfirm={() => run(() => commitDraft(draftRef, false, onApplied))}
            onCancel={() => setFlow(key, null)}
          />
        </Stack>
      )
    case 'conflict':
      return (
        <Callout tone="warning" title={flow.message}>
          <Stack gap="sm">
            <Text size="sm">Reload drops your edits. Apply anyway overwrites what changed.</Text>
            <Row gap="sm" wrap>
              <Button variant="outline" size="sm" disabled={flow.busy} onPress={() => run(() => reloadDraft(draftRef))}>
                Reload
              </Button>
              <Button variant="solid" size="sm" disabled={flow.busy} onPress={() => run(() => commitDraft(draftRef, true, onApplied))}>
                Apply anyway
              </Button>
            </Row>
          </Stack>
        </Callout>
      )
    case 'applied': {
      const { returnTo } = flow
      return (
        <Callout tone="success" title={clipTitle(flow.label)}>
          <Row gap="sm" wrap>
            {returnTo !== null ? (
              <Button variant="outline" size="sm" onPress={() => goBack(returnTo.workspaceId)}>
                {`Back to ${clipTitle(returnTo.name)}`}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={() => finish(draftRef)}>
              Done
            </Button>
          </Row>
        </Callout>
      )
    }
    case 'notice':
      return (
        <Callout tone={flow.notice.tone} title={flow.notice.title}>
          <Text size="sm">{flow.notice.message}</Text>
        </Callout>
      )
    default:
      return <></>
  }
}

/** Vrai tant qu'un récapitulatif, un conflit, un succès ou un avis de ce brouillon est affiché. */
export function draftHasFlow(ref: DraftRef): boolean {
  return read(draftFlows)[draftKey(ref)] !== undefined
}

type DraftControlsProps = {
  draftRef: DraftRef
  label: string
  /** Appelé dès que l'écriture est appliquée : la vue hôte relit l'objet écrit. */
  onApplied?: () => void
}

export function DraftControls({ draftRef, label, onApplied }: DraftControlsProps): OrcaNode {
  const key = draftKey(draftRef)
  const status = read(draftsStatus)
  const info = read(draftInfos)[key] ?? null
  const flow = read(draftFlows)[key]
  const opened = read(draftOpened)[key] === true
  const busy = isBusy(flow)
  // Tant que le dossier n'est pas lu (null), rien n'est interdit : l'ouverture dirait elle-même `drafts_missing`.
  const missing = status !== null && !status.ready
  // Au milieu d'un récapitulatif, d'un conflit ou d'un succès, les boutons d'ouverture et d'application se taisent.
  const inFlow = flow?.step === 'review' || flow?.step === 'conflict' || flow?.step === 'applied'
  const savedAt = info?.unapplied ? clock(info.savedAt) : null
  const kept = info?.unapplied === true || opened
  return (
    <Stack gap="sm">
      {missing ? <SetupCard folder={status.folder} /> : null}
      {flow !== undefined ? <FlowView draftRef={draftRef} flow={flow} onApplied={onApplied} /> : null}
      {inFlow ? null : (
        <Stack gap="sm">
          {kept ? (
            <Text size="sm">
              {info?.unapplied ? (savedAt !== null ? `Unapplied draft from ${savedAt}` : 'Unapplied draft') : 'Draft open in the editor. Save it, then press Apply.'}
            </Text>
          ) : null}
          <Row gap="sm" align="center" wrap>
            <Button variant="outline" size="sm" disabled={busy || missing} onPress={() => run(() => openDraft(draftRef))}>
              {label}
            </Button>
            {kept ? (
              <>
                <Button variant="solid" size="sm" disabled={busy} onPress={() => run(() => applyDraft(draftRef))}>
                  Apply
                </Button>
                <ConfirmAction
                  actionKey={`${key}:discard`}
                  label="Discard"
                  question="Discard this draft? Your edits in the file are lost."
                  confirmLabel="Discard"
                  disabled={busy}
                  onConfirm={() => resetDraft(draftRef)}
                />
              </>
            ) : null}
          </Row>
        </Stack>
      )}
    </Stack>
  )
}
