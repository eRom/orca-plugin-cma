// Envoi de fichiers comme mémoires : les lignes en attente d'une banque (un chemin, un fichier local), leur
// validation avant tout envoi, et le cycle Apply (préparation, récapitulatif, confirmation, conflit, succès).
// Le panneau ne voit que des chemins : le worker choisit le fichier (`file.pick`), le lit et le prépare
// (`memory.stageUploads`). Les lignes sont persistées par banque, jamais un contenu.
import { atom, Box, Button, Callout, IconButton, Input, plugin, read, Row, set, Stack, Text, update } from 'orca'
import { clipLabel } from '../blocks/clip-label'
import { EmptyView } from '../blocks/empty-view'
import { GroupCard } from '../blocks/group-card'
import { LoadingState } from '../blocks/loading-state'
import type { MemoryRow, MemoryStoreDetail, PreparedWrite } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath, MEMORY_PATH_TAKEN, overlaps } from '../shared/memory-path'
import { clipBytes } from '../shared/text'
import { ChangesPreview } from './changes'
import { configDetail, loadConfigs, loadDetail } from './config-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, run } from './state'

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/**
 * La boîte de dialogue du système attend la personne : bien plus que les 30 s par défaut d'une requête. Orca refuse
 * une attente de plus de 120 000 ms (`Too big: expected number to be <=120000`), c'est donc le plafond.
 */
export const PICK_TIMEOUT_MS = 120_000
/**
 * Dit sous la ligne quand la boîte n'a pas répondu dans ce délai. Elle reste ouverte côté worker, qui n'en garde qu'une :
 * un nouvel appui la rejoint (il reçoit sa réponse), il n'en ouvre pas une seconde.
 */
const PICK_STILL_OPEN = 'The file dialog is still open. Press the button again to wait for your choice.'
/**
 * Plafond du nom de fichier affiché dans le bouton : au-delà, le milieu est remplacé par « … » (l'extension reste, le chemin
 * complet est en infobulle). Réglé sur une capture à 220 px : le bouton y tient avec son icône, sans déborder de la carte.
 */
const FILE_NAME_LIMIT = 13
const CHOOSE_LABEL = 'Choose file…'
/** Infobulle d'une ligne sans fichier : tout bouton de fichier en a une, la même largeur de bouton à chaque ligne. */
const CHOOSE_TOOLTIP = 'Choose a file to upload'

/** Fin gardée d'un nom coupé par le milieu : assez pour lire l'extension et un bout du nom (`name.md`). */
const KEPT_TAIL = 7

/** Coupe un nom trop long par le milieu en gardant sa fin : `long-long-…name.md`. */
function middleClip(name: string, limit: number): string {
  const chars = Array.from(name)
  if (chars.length <= limit) return name
  const head = limit - KEPT_TAIL - 1
  // Pas de place pour une tête lisible avec la fin : on coupe la fin, comme un libellé ordinaire.
  if (head < 3) return `${chars.slice(0, limit - 1).join('')}…`
  return `${chars.slice(0, head).join('')}…${chars.slice(-KEPT_TAIL).join('')}`
}

// --- Lignes en attente ---

/** Une ligne en attente : `file` et `name` valent '' tant qu'aucun fichier n'est choisi ; `memoryId` non nul : remplace cette mémoire. */
type UploadRow = { id: string; path: string; file: string; name: string; memoryId: string | null }

/**
 * Les lignes en attente, par identifiant de banque. Persisté : elles survivent à un redémarrage. Des chemins
 * seulement (le chemin de la mémoire, le chemin du fichier local, son nom), jamais le contenu d'un fichier.
 */
const uploadRows = atom<Record<string, UploadRow[]>>('memory.uploads', {}, { persist: 'plugin' })

let rowSeq = 0

function newRowId(): string {
  rowSeq += 1
  return `r${Date.now().toString(36)}${rowSeq.toString(36)}`
}

function setRows(storeId: string, change: (rows: UploadRow[]) => UploadRow[]): void {
  update(uploadRows, (all) => {
    const { [storeId]: current = [], ...rest } = all
    const next = change(current)
    return next.length === 0 ? rest : { ...rest, [storeId]: next }
  })
}

/** Une ligne que la personne ajoute, modifie ou retire périme l'avis du dernier envoi refusé. */
function clearNotice(storeId: string): void {
  if (read(uploadFlows)[storeId]?.step === 'notice') setFlow(storeId, null)
}

function patchRow(storeId: string, rowId: string, changes: Partial<Omit<UploadRow, 'id'>>): void {
  clearNotice(storeId)
  setRows(storeId, (rows) => rows.map((row) => (row.id === rowId ? { ...row, ...changes } : row)))
}

/** Ajoute une ligne vide à la banque. */
function addUploadRow(storeId: string): void {
  clearNotice(storeId)
  setRows(storeId, (rows) => [...rows, { id: newRowId(), path: '', file: '', name: '', memoryId: null }])
}

/** « Replace… » : une ligne pré-remplie avec le chemin et l'identifiant de la mémoire ; une seule par mémoire. */
export function addReplaceRow(storeId: string, memoryId: string, path: string): void {
  clearNotice(storeId)
  setRows(storeId, (rows) =>
    rows.some((row) => row.memoryId === memoryId) ? rows : [...rows, { id: newRowId(), path, file: '', name: '', memoryId }]
  )
}

/** La banque est archivée ou supprimée : ses lignes en attente ne mènent plus nulle part. */
export function dropStoreUploads(storeId: string): void {
  setRows(storeId, () => [])
  update(uploadFlows, ({ [storeId]: _dropped, ...rest }) => rest)
}

/** Une mémoire est supprimée : sa ligne « Replace » en attente ne mène plus nulle part. */
export function dropReplaceRows(storeId: string, memoryId: string): void {
  for (const row of read(uploadRows)[storeId] ?? []) {
    if (row.memoryId === memoryId) removeRow(storeId, row.id)
  }
}

function removeRow(storeId: string, rowId: string): void {
  clearNotice(storeId)
  setRows(storeId, (rows) => rows.filter((row) => row.id !== rowId))
  update(pickFailures, ({ [rowId]: _dropped, ...rest }) => rest)
}

/**
 * Le message de chaque ligne en défaut : chemin invalide, ou recouvrant celui d'une mémoire de la banque (autre que
 * celle remplacée) ou d'une ligne plus haut. Même règle (`overlaps`) et mêmes textes que le worker.
 */
function rowMessages(rows: readonly UploadRow[], memories: readonly MemoryRow[]): Record<string, string> {
  const messages: Record<string, string> = {}
  const seen: string[] = []
  for (const row of rows) {
    if (row.path === '') continue
    if (!isSafeMemoryPath(row.path)) {
      messages[row.id] = INVALID_MEMORY_PATH
      continue
    }
    if (seen.some((earlier) => overlaps(earlier, row.path)) || memories.some((memory) => memory.id !== row.memoryId && overlaps(memory.path, row.path))) {
      messages[row.id] = MEMORY_PATH_TAKEN
    }
    seen.push(row.path)
  }
  return messages
}

const isComplete = (row: UploadRow, messages: Record<string, string>): boolean =>
  row.path !== '' && row.file !== '' && messages[row.id] === undefined

// --- État éphémère ---

/** La ligne dont la boîte de choix de fichier est ouverte : une seule à la fois. */
const pickingRow = atom<string | null>(null)
/** Refus du choix d'un fichier, par ligne (hors macOS, boîte impossible à ouvrir) : il ne bloque pas Apply. */
const pickFailures = atom<Record<string, string>>({})

type Notice = { tone: 'warning' | 'danger'; title: string; message: string }

/** Où en est l'envoi d'une banque. Absent : au repos. `busy` : un envoi est en route, les boutons sont grisés. */
type Flow =
  | { step: 'preparing' }
  | { step: 'review'; prepared: PreparedWrite; rowIds: string[]; busy: boolean; error: string | null }
  /** `progress` : « Uploaded 1 of 2. » quand l'envoi s'est arrêté après des lignes déjà passées, sinon null. */
  | { step: 'conflict'; prepared: PreparedWrite; rowIds: string[]; busy: boolean; progress: string | null }
  | { step: 'applied'; label: string }
  | { step: 'notice'; notice: Notice }

const uploadFlows = atom<Record<string, Flow>>({})

function setFlow(storeId: string, flow: Flow | null): void {
  update(uploadFlows, (flows) => {
    const { [storeId]: _dropped, ...rest } = flows
    return flow === null ? rest : { ...rest, [storeId]: flow }
  })
}

/** Vrai tant qu'une préparation, un récapitulatif ou un conflit est ouvert : les lignes ne bougent plus (l'écriture en attente les a lues). */
function isLocked(flow: Flow | undefined): boolean {
  return flow?.step === 'preparing' || flow?.step === 'review' || flow?.step === 'conflict'
}

// --- Actions ---

async function pickFile(storeId: string, rowId: string): Promise<void> {
  if (read(pickingRow) !== null) return
  set(pickingRow, rowId)
  update(pickFailures, ({ [rowId]: _dropped, ...rest }) => rest)
  try {
    let result
    try {
      result = await plugin.request('file.pick', undefined, { timeoutMs: PICK_TIMEOUT_MS })
    } catch (error) {
      if (!(error instanceof Error) || (error as { code?: unknown }).code !== 'timeout') throw error
      update(pickFailures, (failures) => ({ ...failures, [rowId]: PICK_STILL_OPEN }))
      return
    }
    if (!result.ok) {
      update(pickFailures, (failures) => ({ ...failures, [rowId]: clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text }))
      return
    }
    // Boîte annulée : rien ne change. Ligne retirée pendant l'attente : `patchRow` ne trouve plus rien.
    if (result.value !== null) patchRow(storeId, rowId, { file: result.value.file, name: result.value.name })
  } finally {
    set(pickingRow, null)
  }
}

/** Relit la liste puis le détail de la banque (le détail est en place une fois la relecture finie). */
async function reloadStore(storeId: string): Promise<void> {
  await loadConfigs('memory_store')
  await loadDetail('memory_store', storeId)
}

/**
 * Relit la banque puis retire les lignes de création dont le chemin y existe maintenant : après un envoi à moitié passé
 * ou un jeton perdu, ces fichiers sont déjà en ligne et les renvoyer serait refusé (« chemin pris »). Les remplacements restent.
 */
async function reloadAndDropCreated(storeId: string): Promise<void> {
  await reloadStore(storeId)
  const detail = read(configDetail)
  if (detail?.kind !== 'memory_store' || detail.id !== storeId) return
  const existing = new Set(detail.memories.map((memory) => memory.path.toLowerCase()))
  setRows(storeId, (rows) => rows.filter((row) => row.memoryId !== null || !existing.has(row.path.toLowerCase())))
}

const WARNING_CODES = ['nothing_to_apply', 'expired', 'invalid']

async function showFailure(storeId: string, failure: { code: string; error: string }): Promise<void> {
  if (failure.code === 'unauthorized') {
    setFlow(storeId, null)
    await loadWorkspace()
    return
  }
  const warning = WARNING_CODES.includes(failure.code)
  setFlow(storeId, {
    step: 'notice',
    notice: {
      tone: warning ? 'warning' : 'danger',
      title: warning ? 'Not uploaded' : 'Could not upload',
      message: clipBytes(failure.error, ERROR_TEXT_LIMIT_BYTES).text
    }
  })
}

/** Prépare l'envoi de toutes les lignes complètes : une seule écriture en attente, puis le récapitulatif. */
async function applyUploads(storeId: string, rows: readonly UploadRow[]): Promise<void> {
  if (isLocked(read(uploadFlows)[storeId])) return
  setFlow(storeId, { step: 'preparing' })
  try {
    const result = await plugin.request('memory.stageUploads', {
      memoryStoreId: storeId,
      items: rows.map(({ path, file, memoryId }) => ({ path, file, memoryId }))
    })
    if (!result.ok) return await showFailure(storeId, result)
    setFlow(storeId, { step: 'review', prepared: result.value, rowIds: rows.map((row) => row.id), busy: false, error: null })
  } catch (error) {
    setFlow(storeId, null)
    throw error
  }
}

/** « Uploaded 1 of 2. … » : l'envoi s'est arrêté en route, les premières lignes sont déjà dans la banque. */
const PROGRESS = /^Uploaded \d+ of \d+\./

const isPartial = (message: string): boolean => PROGRESS.test(message)

/** Le début « Uploaded 1 of 2. » d'un message d'envoi interrompu, ou null. */
const progressOf = (message: string): string | null => PROGRESS.exec(message)?.[0] ?? null

/** Envoie l'écriture en attente. Un conflit rouvre le choix ; un jeton perdu ou un envoi à moitié passé relit la banque ; tout autre échec garde le jeton. */
async function commitUploads(storeId: string, force: boolean): Promise<void> {
  const flow = read(uploadFlows)[storeId]
  if ((flow?.step !== 'review' && flow?.step !== 'conflict') || flow.busy) return
  const { prepared, rowIds } = flow
  setFlow(storeId, { ...flow, busy: true })
  let result
  try {
    result = await plugin.request('write.commit', { token: prepared.token, force })
  } catch (error) {
    setFlow(storeId, { ...flow, busy: false })
    throw error
  }
  if (result.ok) {
    // Les lignes envoyées (et celles que l'envoi a sautées, identiques à la banque) n'ont plus rien à attendre.
    setRows(storeId, (rows) => rows.filter((row) => !rowIds.includes(row.id)))
    setFlow(storeId, { step: 'applied', label: result.value.label })
    await reloadStore(storeId)
    return
  }
  switch (result.code) {
    case 'conflict':
      setFlow(storeId, { step: 'conflict', prepared, rowIds, busy: false, progress: progressOf(result.error) })
      return
    case 'unauthorized':
    case 'nothing_to_apply':
    case 'invalid':
      await showFailure(storeId, result)
      return
    case 'expired':
      await showFailure(storeId, result)
      await reloadAndDropCreated(storeId)
      return
    default:
      setFlow(storeId, { step: 'review', prepared, rowIds, busy: false, error: clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text })
      if (isPartial(result.error)) await reloadAndDropCreated(storeId)
  }
}

/**
 * « Reload » d'un conflit : relit la banque, retire les lignes créées avant l'arrêt (elles sont déjà en ligne) et garde
 * les autres ; l'écriture en attente est abandonnée. Un envoi à moitié passé laisse un avis qui dit où il s'est arrêté.
 */
async function reloadAfterConflict(storeId: string): Promise<void> {
  const flow = read(uploadFlows)[storeId]
  if (flow?.step !== 'conflict' || flow.busy) return
  setFlow(
    storeId,
    flow.progress === null
      ? null
      : {
          step: 'notice',
          notice: { tone: 'warning', title: 'Partly uploaded', message: `${flow.progress} The memory store changed elsewhere: your other rows are kept.` }
        }
  )
  await reloadAndDropCreated(storeId)
}

// --- Rendu ---

type LineProps = { storeId: string; row: UploadRow; message: string | undefined; locked: boolean }

function UploadLine({ storeId, row, message, locked }: LineProps) {
  const picking = read(pickingRow)
  const failure = read(pickFailures)[row.id]
  const replaces = row.memoryId !== null
  // Deux lignes à toute largeur, sans retour à la ligne laissé au hasard : le chemin sur toute la largeur, puis le fichier
  // (qui prend la place libre) et le × collé à la fin. `paddingY` donne au filet entre deux lignes (GroupCard) de l'air des deux côtés.
  return (
    <Box paddingY="sm">
      <Stack gap="xs">
        <Input
          label="Memory path"
          labelHidden
          placeholder="/notes/today.md"
          value={row.path}
          invalid={message !== undefined}
          disabled={locked || replaces}
          onChange={(value) => patchRow(storeId, row.id, { path: value })}
        />
        <Row gap="sm" align="center">
          <Box key="file" grow minWidth={0}>
            <Button
              variant="outline"
              size="sm"
              icon="file"
              tooltip={row.file === '' ? CHOOSE_TOOLTIP : clipLabel(row.file)}
              disabled={locked || picking !== null}
              onPress={() => run(() => pickFile(storeId, row.id))}
            >
              {row.name === '' ? CHOOSE_LABEL : middleClip(row.name, FILE_NAME_LIMIT)}
            </Button>
          </Box>
          <Box key="remove" shrink={false}>
            <IconButton icon="close" label="Remove" variant="ghost" size="sm" disabled={locked} onPress={() => removeRow(storeId, row.id)} />
          </Box>
        </Row>
        {message !== undefined ? (
          <Text tone="danger" size="xs">
            {message}
          </Text>
        ) : failure !== undefined ? (
          <Text tone="danger" size="xs">
            {failure}
          </Text>
        ) : replaces ? (
          <Text muted size="xs">
            Replaces the content of this memory.
          </Text>
        ) : null}
      </Stack>
    </Box>
  )
}

function FlowView({ storeId, flow }: { storeId: string; flow: Flow }) {
  switch (flow.step) {
    case 'review':
      return (
        <Stack gap="sm">
          {flow.error !== null ? (
            <Callout tone="danger" title="Could not upload">
              <Text size="sm">{flow.error}</Text>
            </Callout>
          ) : null}
          <ChangesPreview
            prepared={flow.prepared}
            busy={flow.busy}
            onConfirm={() => run(() => commitUploads(storeId, false))}
            onCancel={() => setFlow(storeId, null)}
          />
        </Stack>
      )
    case 'conflict':
      return (
        <Callout tone="warning" title={CONFLICT_TITLE}>
          <Stack gap="sm">
            {flow.progress === null ? null : <Text size="sm">{flow.progress}</Text>}
            <Text size="sm">Reload rereads the memory store and keeps your rows. Apply anyway overwrites what changed.</Text>
            <Row gap="sm" wrap>
              <Button variant="outline" size="sm" disabled={flow.busy} onPress={() => run(() => reloadAfterConflict(storeId))}>
                Reload
              </Button>
              <Button variant="solid" size="sm" disabled={flow.busy} onPress={() => run(() => commitUploads(storeId, true))}>
                Apply anyway
              </Button>
            </Row>
          </Stack>
        </Callout>
      )
    case 'applied':
      return (
        <Callout tone="success" title={clipLabel(flow.label)}>
          <Row>
            <Button variant="ghost" size="sm" onPress={() => setFlow(storeId, null)}>
              Done
            </Button>
          </Row>
        </Callout>
      )
    case 'notice':
      return (
        <Callout tone={flow.notice.tone} title={flow.notice.title}>
          <Text size="sm">{flow.notice.message}</Text>
        </Callout>
      )
    default:
      return null
  }
}

/** La zone « To upload » : les lignes en attente, `Add` pour en ajouter une, et un seul `Apply (n)` dessous. */
export function UploadsSection({ store }: { store: MemoryStoreDetail }) {
  const rows = read(uploadRows)[store.id] ?? []
  const flow = read(uploadFlows)[store.id]
  const locked = isLocked(flow)
  const messages = rowMessages(rows, store.memories)
  const ready = rows.filter((row) => isComplete(row, messages)).length
  // Tant qu'une boîte de choix de fichier est ouverte, la ligne qu'elle remplit n'est pas à jour : Apply attend.
  const blocked = rows.length === 0 || ready !== rows.length || read(pickingRow) !== null
  // Pendant un récapitulatif ou un conflit, `Apply` laisse la place à leurs boutons.
  const showApply = rows.length > 0 && !locked
  return (
    <Stack gap="sm">
      <GroupCard
        title="To upload"
        trailing={
          <Button variant="ghost" size="sm" icon="add" disabled={locked} onPress={() => addUploadRow(store.id)}>
            Add
          </Button>
        }
        rows={
          rows.length === 0
            ? [<EmptyView kind="list" text="Add a row, give it a memory path and choose a file." />]
            : rows.map((row) => ({
                key: row.id,
                row: <UploadLine storeId={store.id} row={row} message={messages[row.id]} locked={locked} />
              }))
        }
      />
      {flow === undefined ? null : <FlowView storeId={store.id} flow={flow} />}
      {showApply ? (
        <Stack gap="xs">
          <Row>
            <Button key="apply" variant="solid" tone="accent" disabled={blocked} onPress={() => run(() => applyUploads(store.id, rows))}>
              {`Apply (${ready})`}
            </Button>
          </Row>
          {rows.some((row) => row.path === '' || row.file === '') ? (
            <Text muted size="xs">
              Choose a file for every row, or remove it.
            </Text>
          ) : null}
        </Stack>
      ) : null}
      {flow?.step === 'preparing' ? <LoadingState kind="operation" label="Reading the files…" /> : null}
    </Stack>
  )
}
