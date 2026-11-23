// L'onglet Resources : deux cartes, les skills et les fichiers du workspace actif. Chaque carte téléverse (`+`), une
// skill envoie une nouvelle version (`↑`), les deux suppriment (`X` après confirmation). Le champ de filtre est celui
// de l'accueil (`FilterRow`), partagé par les deux cartes.
import { Button, Callout, IconButton, plugin, read, Row, set, Spinner, Stack, Text, type OrcaElement } from 'orca'
import { clipLabel } from '../blocks/clip-label'
import { EmptyView } from '../blocks/empty-view'
import { GroupCard } from '../blocks/group-card'
import type { IconAction } from '../blocks/icon-action'
import { ItemRow } from '../blocks/item-row'
import type { ApiResult, FileRow, PickedFile, SkillRow } from '../protocol'
import { RESOURCE_UPLOAD_WAIT_MS, UPLOAD_UNCONFIRMED } from '../protocol'
import { formatDecimalSize } from '../shared/size'
import { clipBytes } from '../shared/text'
import { RENDER_ROW_CAP } from './config-state'
import { askConfirmation, ConfirmPanel, deleteQuestion } from './confirm'
import { PICK_TIMEOUT_MS } from './memory-uploads'
import {
  currentGeneration,
  fileRows,
  filterResources,
  loadFiles,
  loadSkills,
  resourceErrors,
  resourceNotices,
  resourcePicking,
  resourceUploading,
  setCardValue,
  skillRows,
  type CardKey,
  type CardNotice
} from './resource-state'
import {
  ERROR_TEXT_LIMIT_BYTES,
  filterOf,
  loadWorkspace,
  ROW_SUBTITLE_LIMIT_BYTES,
  ROW_TITLE_LIMIT_BYTES,
  run,
  sessionRows
} from './state'

/** Dit sous la carte quand la boîte n'a pas répondu dans le délai ; un nouvel appui la rejoint, il n'en ouvre pas une seconde. */
const PICK_STILL_OPEN = 'The dialog is still open. Press the button again to wait for your choice.'
const SKILL_DELETE_WARNING = ' Agents that use this skill will no longer find it.'

const PICK_OPTIONS = { timeoutMs: PICK_TIMEOUT_MS }
const UPLOAD_OPTIONS = { timeoutMs: RESOURCE_UPLOAD_WAIT_MS }

/** Un nom venu de l'API ou du disque, coupé avant d'entrer dans un libellé (Orca refuse un libellé de plus de 1 Kio). */
const clipName = (name: string): string => clipBytes(name, ROW_TITLE_LIMIT_BYTES).text

const errorText = (error: unknown): string => clipBytes(error instanceof Error ? error.message : String(error), ERROR_TEXT_LIMIT_BYTES).text

const isHostTimeout = (error: unknown): boolean => error instanceof Error && (error as { code?: unknown }).code === 'timeout'

// --- Actions ---

function setNotice(card: CardKey, notice: CardNotice | null): void {
  setCardValue(resourceNotices, card, notice)
}

const refusal = (title: string, message: string): CardNotice => ({ tone: 'danger', title, message })

/** Relit la liste d'une carte. Une lecture qui échoue montre son erreur sur la carte (avec Retry), elle ne remonte pas. */
async function reread(card: CardKey, startedIn: number): Promise<void> {
  try {
    await (card === 'skills' ? loadSkills() : loadFiles())
  } catch (error) {
    if (startedIn !== currentGeneration()) return
    set(resourceErrors, { ...read(resourceErrors), [card]: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Ouvre la boîte de choix de la carte. `null` : rien à envoyer (boîte annulée ou toujours ouverte, refus, bascule de
 * workspace, ou clé refusée). Un seul choix à la fois par carte : le worker rend la même boîte à chaque appel.
 */
async function pick(card: CardKey, startedIn: number): Promise<PickedFile | null> {
  setCardValue(resourcePicking, card, true)
  try {
    let result: ApiResult<PickedFile | null>
    try {
      result = await (card === 'skills'
        ? plugin.request('skills.pickFolder', undefined, PICK_OPTIONS)
        : plugin.request('files.pickFile', undefined, PICK_OPTIONS))
    } catch (error) {
      if (startedIn !== currentGeneration()) return null
      if (!isHostTimeout(error)) throw error
      setNotice(card, { tone: 'warning', title: PICK_STILL_OPEN, message: null })
      return null
    }
    if (startedIn !== currentGeneration()) return null
    if (result.ok) return result.value
    if (result.code === 'unauthorized') await loadWorkspace()
    else setNotice(card, refusal('Could not upload', clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text))
    return null
  } finally {
    if (startedIn === currentGeneration()) setCardValue(resourcePicking, card, false)
  }
}

type UploadOutcome = ApiResult<string> | 'unconfirmed'

/** Envoie le choix. La valeur d'un succès est le texte de l'avis ; une attente épuisée rend `unconfirmed`, un rejet de l'hôte un refus. */
async function sendUpload(card: CardKey, picked: PickedFile, skill: { id: string; name: string } | null): Promise<UploadOutcome> {
  try {
    if (card === 'files') {
      const result = await plugin.request('files.upload', { file: picked.file }, UPLOAD_OPTIONS)
      return result.ok ? { ok: true, value: `Uploaded ${clipName(result.value.name)}.` } : result
    }
    if (skill !== null) {
      const result = await plugin.request('skills.uploadVersion', { skillId: skill.id, folder: picked.file }, UPLOAD_OPTIONS)
      return result.ok ? { ok: true, value: `New version of ${clipName(skill.name)} uploaded.` } : result
    }
    const result = await plugin.request('skills.upload', { folder: picked.file }, UPLOAD_OPTIONS)
    return result.ok ? { ok: true, value: `Uploaded ${clipName(result.value.name)}.` } : result
  } catch (error) {
    if (isHostTimeout(error)) return 'unconfirmed'
    // Un rejet de l'hôte (worker indisponible) est un refus comme un autre : il s'affiche sur la carte, sans bandeau.
    return { ok: false, code: 'other', error: errorText(error) }
  }
}

/**
 * Choisit puis envoie : `+` d'une carte, ou `↑` d'une skill (`skill` non nul : nouvelle version de celle-ci). Après un
 * `await`, une bascule de workspace (génération changée) arrête tout sans rien afficher ni envoyer.
 */
async function startUpload(card: CardKey, skill: { id: string; name: string } | null): Promise<void> {
  if (read(resourcePicking)[card] || read(resourceUploading)[card] !== null) return
  const startedIn = currentGeneration()
  setNotice(card, null)
  const picked = await pick(card, startedIn)
  if (picked === null) return
  setCardValue(resourceUploading, card, clipName(skill?.name ?? picked.name))
  try {
    const outcome = await sendUpload(card, picked, skill)
    if (startedIn !== currentGeneration()) return
    // Le worker dit lui-même qu'une attente épuisée est peut-être passée : même avis que l'attente épuisée de l'hôte.
    if (outcome === 'unconfirmed' || (!outcome.ok && outcome.error === UPLOAD_UNCONFIRMED)) {
      setNotice(card, { tone: 'warning', title: UPLOAD_UNCONFIRMED, message: null })
    } else if (outcome.ok) {
      setNotice(card, { tone: 'success', title: outcome.value, message: null })
    } else if (outcome.code === 'unauthorized') {
      await loadWorkspace()
      return
    } else {
      setNotice(card, refusal('Could not upload', clipBytes(outcome.error, ERROR_TEXT_LIMIT_BYTES).text))
    }
    await reread(card, startedIn)
  } finally {
    if (startedIn === currentGeneration()) setCardValue(resourceUploading, card, null)
  }
}

/** Supprime une ligne. Ne lève jamais : un refus pose l'avis de la carte et rend la main, la question se ferme. */
async function deleteResource(card: CardKey, id: string, name: string): Promise<void> {
  const startedIn = currentGeneration()
  setNotice(card, null)
  let result: ApiResult<null>
  try {
    result = await (card === 'skills' ? plugin.request('skills.delete', { skillId: id }) : plugin.request('files.delete', { fileId: id }))
  } catch (error) {
    // Un rejet de l'hôte (délai, worker indisponible) : l'avis de la carte, puis la relecture comme pour tout refus.
    if (startedIn !== currentGeneration()) return
    setNotice(card, refusal('Could not delete', errorText(error)))
    await reread(card, startedIn)
    return
  }
  if (startedIn !== currentGeneration()) return
  if (result.ok) {
    setNotice(card, { tone: 'success', title: `Deleted ${clipName(name)}.`, message: null })
  } else if (result.code === 'unauthorized') {
    // `onConfirm` ne lève jamais : une identité qu'on ne peut pas relire devient l'avis de la carte.
    try {
      await loadWorkspace()
    } catch (error) {
      if (startedIn === currentGeneration()) setNotice(card, refusal('Could not delete', errorText(error)))
    }
    return
  } else {
    setNotice(card, refusal('Could not delete', clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text))
  }
  // Un 404 veut dire que la ligne a déjà disparu : la relecture la retire, réussie ou non la suppression.
  await reread(card, startedIn)
}

// --- Rendu ---

type CardRow = { id: string; title: string; subtitle: string; actions: IconAction[]; confirmation: OrcaElement }

/** Le titre d'une session pour un fichier qui lui est lié, ou son identifiant quand la session est inconnue. */
function sessionLabel(sessionId: string | null): string {
  if (sessionId === null) return ''
  const known = read(sessionRows)?.find((row) => row.id === sessionId)
  return known?.title ?? sessionId
}

/** La ligne d'une skill : `↑` (grisé tant qu'une boîte ou un envoi occupe la carte) puis `X`, la question de suppression dessous. */
function skillCardRow(row: SkillRow, locked: boolean): CardRow {
  const name = clipName(row.name)
  const deleteKey = `skill:${row.id}:delete`
  return {
    id: row.id,
    title: row.name,
    subtitle: row.id,
    actions: [
      {
        key: 'version',
        icon: 'upload',
        label: `Upload a new version of ${name}`,
        disabled: locked,
        onPress: () => run(() => startUpload('skills', { id: row.id, name: row.name }))
      },
      { key: 'delete', icon: 'close', label: `Delete ${name}`, tone: 'danger', onPress: () => askConfirmation(deleteKey) }
    ],
    confirmation: (
      <ConfirmPanel
        actionKey={deleteKey}
        question={deleteQuestion(row.name) + SKILL_DELETE_WARNING}
        confirmLabel="Delete"
        onConfirm={() => deleteResource('skills', row.id, row.name)}
      />
    )
  }
}

function fileCardRow(row: FileRow): CardRow {
  const name = clipName(row.name)
  const deleteKey = `file:${row.id}:delete`
  return {
    id: row.id,
    title: row.name,
    subtitle: [row.id, formatDecimalSize(row.sizeBytes), sessionLabel(row.sessionId)].filter(Boolean).join(' · '),
    actions: [{ key: 'delete', icon: 'close', label: `Delete ${name}`, tone: 'danger', onPress: () => askConfirmation(deleteKey) }],
    confirmation: (
      <ConfirmPanel
        actionKey={deleteKey}
        question={deleteQuestion(row.name)}
        confirmLabel="Delete"
        onConfirm={() => deleteResource('files', row.id, row.name)}
      />
    )
  }
}

function NoticeView({ notice }: { notice: CardNotice }): OrcaElement {
  return (
    <Callout tone={notice.tone} title={clipLabel(notice.title)}>
      {notice.message === null ? null : <Text size="sm">{notice.message}</Text>}
    </Callout>
  )
}

/**
 * Une carte : son titre, son `+`, puis dans l'ordre l'erreur de lecture, l'avis, l'envoi en route, le chargement,
 * le vide ou les lignes. Chaque ligne a une clé fixe : une ligne qui apparaît ou disparaît ne décale pas les autres.
 */
function ResourceCard({
  card,
  title,
  noun,
  addLabel,
  rows,
  total,
  failure,
  onRetry
}: {
  card: CardKey
  title: string
  noun: string
  addLabel: string
  /** Les lignes après filtre ; `null` tant que la liste n'est pas lue. */
  rows: CardRow[] | null
  /** Le nombre de lignes avant filtre : il distingue une liste vide d'un filtre sans résultat. */
  total: number
  failure: string | null
  onRetry: () => void
}): OrcaElement {
  const notice = read(resourceNotices)[card]
  const uploading = read(resourceUploading)[card]
  const shown = rows ?? []
  const items = shown.slice(0, RENDER_ROW_CAP).map((row) => ({
    key: `item-${row.id}`,
    row: (
      <Stack>
        <ItemRow
          title={clipBytes(row.title, ROW_TITLE_LIMIT_BYTES).text}
          subtitle={clipBytes(row.subtitle, ROW_SUBTITLE_LIMIT_BYTES).text}
          actions={row.actions}
        />
        {row.confirmation}
      </Stack>
    )
  }))
  return (
    <GroupCard
      title={title}
      trailing={
        <IconButton
          icon="add"
          label={addLabel}
          variant="ghost"
          size="sm"
          disabled={read(resourcePicking)[card] || uploading !== null}
          onPress={() => run(() => startUpload(card, null))}
        />
      }
      rows={[
        {
          key: 'error',
          row: failure ? (
            <Callout tone="danger" title="Could not load the list">
              <Stack gap="sm">
                <Text size="sm">{clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text}</Text>
                <Row>
                  <Button variant="outline" size="sm" onPress={onRetry}>
                    Retry
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null
        },
        { key: 'notice', row: notice === null ? null : <NoticeView notice={notice} /> },
        { key: 'uploading', row: uploading === null ? null : <Spinner label={`Uploading ${uploading}`} /> },
        {
          key: 'status',
          row:
            rows === null ? (
              failure ? null : (
                <Spinner label={`Loading ${noun}`} />
              )
            ) : total === 0 ? (
              <EmptyView kind="list" text={`No ${noun} yet.`} />
            ) : shown.length === 0 ? (
              <EmptyView kind="list" text="No match" />
            ) : null
        },
        ...items,
        {
          key: 'cap',
          row:
            shown.length > RENDER_ROW_CAP ? (
              <Text muted size="xs">
                {`Showing the first ${RENDER_ROW_CAP} of ${shown.length}. Refine the filter to see the rest.`}
              </Text>
            ) : null
        }
      ]}
    />
  )
}

/** Les deux cartes ; le filtre de l'onglet est posé au-dessus par l'accueil. */
export function ResourcesTab(): OrcaElement {
  const query = filterOf('resources')
  const skills = read(skillRows)
  const files = read(fileRows)
  const errors = read(resourceErrors)
  const skillsLocked = read(resourcePicking).skills || read(resourceUploading).skills !== null
  return (
    <Stack gap="sm">
      <ResourceCard
        card="skills"
        title="Skills"
        noun="skills"
        addLabel="Upload skill"
        rows={skills === null ? null : filterResources(skills, query).map((row) => skillCardRow(row, skillsLocked))}
        total={skills?.length ?? 0}
        failure={errors.skills}
        onRetry={() => run(loadSkills)}
      />
      <ResourceCard
        card="files"
        title="Files"
        noun="files"
        addLabel="Upload file"
        rows={files === null ? null : filterResources(files, query).map(fileCardRow)}
        total={files?.length ?? 0}
        failure={errors.files}
        onRetry={() => run(loadFiles)}
      />
    </Stack>
  )
}
