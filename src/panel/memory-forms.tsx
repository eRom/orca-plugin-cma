// Banques de mémoire et mémoires : l'écran d'une banque (formulaire, mémoires, lignes à envoyer, archivage et
// suppression) et les actions d'une mémoire ouverte (brouillon, remplacement, renommage, suppression).
// La saisie d'une banque est gardée par `form-state` ; le reste de l'état est éphémère, hors les lignes à envoyer
// (`memory-uploads`). Les blocs du kit (`src/blocks/`) sont copiés tels quels : tout s'adapte par leurs props.
import { atom, Box, Button, Callout, IconButton, Input, plugin, read, Row, set, Stack, Text, update, type OrcaNode } from 'orca'
import { ActionRow } from '../blocks/action-row'
import { BackHeader } from '../blocks/back-header'
import { clipLabel } from '../blocks/clip-label'
import { EmptyView } from '../blocks/empty-view'
import { FormSection } from '../blocks/form-section'
import { GroupCard } from '../blocks/group-card'
import { ItemRow } from '../blocks/item-row'
import { LoadingState } from '../blocks/loading-state'
import type { ApiResult, MemoryContent, MemoryRow, MemoryStoreDetail, MemoryStoreForm } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath } from '../shared/memory-path'
import { clipBytes } from '../shared/text'
import { archiveQuestion, askConfirmation, ConfirmPanel, deleteQuestion } from './confirm'
import { configDetail, loadConfigs, loadDetail, loadMemory, memoryDraft, openConfig, openMemory, RENDER_ROW_CAP } from './config-state'
import { DraftControls, draftIsBusy, draftIsUnapplied, startDraft } from './drafts'
import { clearForm, editForm, formConflict, formKey, isTouched, readForm, touchField } from './form-state'
import { addReplaceRow, dropStoreUploads, UploadsSection } from './memory-uploads'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popIfTop, popView, run } from './state'

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafond d'un nom ou d'un chemin repris dans un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200
/** Ajouté à la question d'une suppression quand un brouillon non appliqué existe : le worker le garde, comme une nouvelle mémoire. */
const KEPT_DRAFT_NOTE = ' Your unapplied draft stays as a new memory at this path.'
/** Largeur minimale d'un champ qui partage sa ligne avec un bouton : en dessous, le bouton passe dessous. */
const FIELD_MIN_WIDTH = 140

const clipTitle = (text: string): string => clipBytes(text, TITLE_LIMIT_BYTES).text

function emptyForm(): MemoryStoreForm {
  return { name: '', description: '' }
}

// --- État éphémère ---

/** Vrai pendant l'enregistrement d'une banque : un double appui ne part pas deux fois. */
const saving = atom(false)
/** Refus de l'enregistrement d'une banque (hors conflit), avec le formulaire concerné. */
const saveFailure = atom<{ key: string; message: string } | null>(null)

/** Chemins tapés dans le champ d'un renommage, par identifiant de mémoire ; absent : le chemin actuel. */
const renamePaths = atom<Record<string, string>>({})
/** La mémoire dont le champ de renommage est ouvert. */
const renameOpen = atom<string | null>(null)
/** Vrai pendant un renommage. */
const renaming = atom(false)
/** Refus d'un renommage, avec la mémoire concernée. */
const renameFailure = atom<{ memoryId: string; code: string; message: string } | null>(null)

function discardForm(key: string): void {
  clearForm(key)
  if (read(saveFailure)?.key === key) set(saveFailure, null)
}

function setRenamePath(memoryId: string, path: string | null): void {
  update(renamePaths, (paths) => {
    const { [memoryId]: _dropped, ...rest } = paths
    return path === null ? rest : { ...rest, [memoryId]: path }
  })
}

// --- Écritures ---

type SaveTarget = { key: string; id: string | null; base: MemoryStoreForm; baseUpdatedAt: string | null }

/** Envoie le formulaire. Un conflit ouvre son avis ; un refus s'affiche ; la réussite relit la liste puis le détail. */
async function saveForm(target: SaveTarget, force: boolean): Promise<void> {
  if (read(saving)) return
  const { key, id } = target
  // La base et l'horodatage envoyés sont ceux de la saisie gardée : le worker voit un changement fait ailleurs depuis.
  const { form, base, baseStamp } = readForm(key, target.base, target.baseUpdatedAt)
  set(saving, true)
  set(saveFailure, null)
  try {
    const result = await plugin.request('memoryStore.save', {
      id,
      baseUpdatedAt: typeof baseStamp === 'string' ? baseStamp : null,
      force,
      form,
      base: id === null ? null : base
    })
    if (!result.ok) {
      if (result.code === 'conflict') {
        update(formConflict, (conflicts) => ({ ...conflicts, [key]: true }))
      } else if (result.code === 'unauthorized') {
        await loadWorkspace()
      } else {
        set(saveFailure, { key, message: result.error })
      }
      return
    }
    await loadConfigs('memory_store')
    discardForm(key)
    if (id === null) {
      // Le détail de la nouvelle banque remplace le formulaire de création, s'il est encore ouvert (sinon : Back pressé).
      if (popIfTop((entry) => entry.view === 'newConfig' && entry.kind === 'memory_store')) {
        openConfig('memory_store', result.value.id)
      }
    } else {
      await loadDetail('memory_store', id)
    }
  } finally {
    set(saving, false)
  }
}

/** Relit la banque vivante et abandonne la saisie gardée. */
async function reloadForm(key: string, id: string): Promise<void> {
  discardForm(key)
  await loadDetail('memory_store', id)
}

/** Relit la liste puis le détail de la banque : le geste de « refresh » de l'en-tête, et la suite d'un brouillon appliqué. */
export async function refreshStore(storeId: string): Promise<void> {
  await loadConfigs('memory_store')
  await loadDetail('memory_store', storeId)
}

/** Archive ou supprime la banque, puis revient à l'accueil et relit la liste. Un refus de l'API remonte à `ConfirmPanel`. */
async function removeStore(key: string, id: string, call: () => Promise<ApiResult<null>>): Promise<void> {
  const result = await call()
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  dropStoreUploads(id)
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'memory_store' && entry.id === id)
  await loadConfigs('memory_store')
}

/**
 * Après une écriture sur une mémoire ouverte : la mémoire est relue sans repasser par le chargement, la liste
 * aussi, et le détail de la banque (resté chargé sous la mémoire) est déclaré périmé : `Back` le relit.
 */
async function afterMemoryWrite(storeId: string, memoryId: string): Promise<void> {
  const detail = read(configDetail)
  if (detail?.kind === 'memory_store' && detail.id === storeId) set(configDetail, null)
  await Promise.all([loadMemory(storeId, memoryId, true), loadConfigs('memory_store')])
}

async function renameMemory(memory: MemoryContent, path: string): Promise<void> {
  if (read(renaming)) return
  set(renaming, true)
  set(renameFailure, null)
  try {
    const result = await plugin.request('memory.rename', {
      memoryStoreId: memory.memoryStoreId,
      memoryId: memory.id,
      path,
      baseSha256: memory.sha256
    })
    if (!result.ok) {
      if (result.code === 'unauthorized') {
        await loadWorkspace()
      } else {
        set(renameFailure, { memoryId: memory.id, code: result.code, message: result.error })
      }
      return
    }
    setRenamePath(memory.id, null)
    set(renameOpen, null)
    await afterMemoryWrite(memory.memoryStoreId, memory.id)
  } finally {
    set(renaming, false)
  }
}

/** « Reload » d'un renommage refusé parce que le contenu a changé : relit la mémoire et oublie le chemin tapé. */
async function reloadMemory(memory: MemoryContent): Promise<void> {
  setRenamePath(memory.id, null)
  set(renameFailure, null)
  await loadMemory(memory.memoryStoreId, memory.id, true)
}

/** Supprime la mémoire, puis revient au détail de sa banque relu. Un refus de l'API remonte à `ConfirmPanel`. */
async function deleteMemory(memory: MemoryContent): Promise<void> {
  const result = await plugin.request('resource.delete', { kind: 'memory', memoryStoreId: memory.memoryStoreId, id: memory.id })
  if (!result.ok) throw new Error(result.error)
  setRenamePath(memory.id, null)
  popIfTop((entry) => entry.view === 'memory' && entry.memoryId === memory.id)
  await loadConfigs('memory_store')
  // Sans condition : si Back a été pressé pendant la suppression, la banque est déjà au sommet avec un détail
  // périmé. `loadDetail` l'efface d'abord, et laisse tomber sa réponse si la banque n'est plus la vue ouverte.
  await loadDetail('memory_store', memory.memoryStoreId)
}

/** « Replace… » : ajoute la ligne à la banque, puis y revient (relue si elle a été déclarée périmée par une écriture). */
function replaceMemory(memory: MemoryContent): void {
  addReplaceRow(memory.memoryStoreId, memory.id, memory.path)
  update(nav, popView)
  if (read(configDetail)?.id !== memory.memoryStoreId) run(() => loadDetail('memory_store', memory.memoryStoreId))
}

function goBack(): void {
  update(nav, popView)
}

// --- Banque : rendu ---

type BodyProps = { id: string | null; base: MemoryStoreForm; baseUpdatedAt: string | null }

/** Name et Description sous leur Save ; `Discard` n'apparaît que sur une saisie modifiée. */
function MemoryStoreFormBody({ id, base, baseUpdatedAt }: BodyProps) {
  const key = formKey('memory_store', id)
  const { form, dirty, stale } = readForm(key, base, baseUpdatedAt)
  const latest = (): MemoryStoreForm => readForm(key, base, baseUpdatedAt).form
  const change = (changes: Partial<MemoryStoreForm>): void => editForm(key, { ...latest(), ...changes }, base, baseUpdatedAt)
  const target: SaveTarget = { key, id, base, baseUpdatedAt }
  // Conflit annoncé par le worker, ou saisie gardée commencée sur une autre version que celle chargée.
  const conflict = read(formConflict)[key] === true || stale
  const busy = read(saving)
  const failed = read(saveFailure)
  const nameMissing = form.name.trim() === ''
  // L'erreur du nom attend que la personne l'ait modifié une fois : un formulaire neuf ne s'ouvre pas en rouge.
  const nameInvalid = nameMissing && isTouched(key, 'name')
  return (
    <FormSection
      title={id === null ? undefined : 'Details'}
      saveLabel={id === null ? 'Create' : 'Save'}
      // `busy` grise Save : il dit aussi « rien à enregistrer » (saisie intacte) et « nom manquant ».
      busy={busy || nameMissing || (id !== null && !dirty)}
      error={failed?.key === key ? clipBytes(failed.message, ERROR_TEXT_LIMIT_BYTES).text : undefined}
      errorTitle="Could not save"
      onSave={() => run(() => saveForm(target, false))}
      cancelLabel="Discard"
      onCancel={dirty ? () => discardForm(key) : undefined}
    >
      {[
        conflict && id !== null ? (
          <Callout key="conflict" tone="warning" title={CONFLICT_TITLE}>
            <Stack gap="sm">
              <Text size="sm">Reload drops your changes. Save anyway overwrites what changed.</Text>
              <Row gap="sm" wrap>
                <Button variant="outline" size="sm" disabled={busy} onPress={() => run(() => reloadForm(key, id))}>
                  Reload
                </Button>
                <Button variant="solid" size="sm" disabled={busy || nameMissing} onPress={() => run(() => saveForm(target, true))}>
                  Save anyway
                </Button>
              </Row>
            </Stack>
          </Callout>
        ) : null,
        <Input
          key="name"
          label="Name"
          disabled={busy}
          value={form.name}
          invalid={nameInvalid}
          onChange={(value) => {
            touchField(key, 'name')
            change({ name: value })
          }}
        />,
        <Input key="description" label="Description" disabled={busy} placeholder="Optional" value={form.description} onChange={(value) => change({ description: value })} />,
        dirty ? (
          <Text key="dirty" muted size="xs">
            Unsaved changes
          </Text>
        ) : null
      ]}
    </FormSection>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Une mémoire de la banque : sa ligne (✎ ouvre l'éditeur, ⋯ ouvre son détail) et, dessous, ce que dit son brouillon. */
function MemoryLine({ store, memory }: { store: MemoryStoreDetail; memory: MemoryRow }) {
  const draftRef = memoryDraft(store.id, memory.id, memory.path)
  const reread = (): void => run(() => refreshStore(store.id))
  return (
    <Stack gap="xs">
      <ItemRow
        title={clipTitle(memory.path)}
        subtitle={formatSize(memory.sizeBytes)}
        actions={[
          { key: 'edit', icon: 'edit', label: `Edit ${clipLabel(memory.path, 200)} in editor`, disabled: draftIsBusy(draftRef), onPress: () => startDraft(draftRef) },
          { key: 'open', icon: 'more', label: `Open ${clipLabel(memory.path, 200)}`, onPress: () => openMemory(store.id, memory.id) }
        ]}
      />
      <DraftControls draftRef={draftRef} label="Edit in editor" showOpen={false} onApplied={reread} onDiscarded={reread} />
    </Stack>
  )
}

function MemoriesSection({ store }: { store: MemoryStoreDetail }) {
  return (
    <Stack gap="xs">
      <GroupCard
        title="Memories"
        rows={
          store.memories.length === 0
            ? [<EmptyView kind="list" text="No memories yet." />]
            : store.memories.slice(0, RENDER_ROW_CAP).map((memory) => ({ key: memory.id, row: <MemoryLine store={store} memory={memory} /> }))
        }
      />
      {store.memories.length > RENDER_ROW_CAP ? (
        <Text muted size="xs">
          {`Showing the first ${RENDER_ROW_CAP} of ${store.memories.length}. Open in Console for the rest.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Archiver et supprimer la banque : en bas de l'écran, une rangée à part avec sa confirmation. */
function StoreActions({ id, name }: { id: string; name: string }) {
  const key = formKey('memory_store', id)
  const busy = read(saving)
  const archiveKey = `memory_store:${id}:archive`
  const deleteKey = `memory_store:${id}:delete`
  return (
    <Stack gap="sm">
      <ActionRow
        actions={[
          { key: 'archive', label: 'Archive', disabled: busy, onPress: () => askConfirmation(archiveKey) },
          { key: 'delete', label: 'Delete', tone: 'danger', disabled: busy, onPress: () => askConfirmation(deleteKey) }
        ]}
      />
      <ConfirmPanel
        actionKey={archiveKey}
        question={archiveQuestion(name)}
        confirmLabel="Archive"
        disabled={busy}
        onConfirm={() => removeStore(key, id, () => plugin.request('resource.archive', { kind: 'memory_store', id }))}
      />
      <ConfirmPanel
        actionKey={deleteKey}
        question={deleteQuestion(name)}
        confirmLabel="Delete"
        disabled={busy}
        onConfirm={() => removeStore(key, id, () => plugin.request('resource.delete', { kind: 'memory_store', id }))}
      />
    </Stack>
  )
}

/** `id` null : la création ; sinon la banque chargée dans le détail ouvert (son en-tête est celui de `ConfigDetailView`). */
export function MemoryStoreFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <BackHeader title="New memory store" onBack={goBack} />
        <MemoryStoreFormBody id={null} base={emptyForm()} baseUpdatedAt={null} />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'memory_store' || detail.id !== id) return <LoadingState kind="operation" label="Loading details" />
  return (
    <Stack gap="lg">
      <MemoryStoreFormBody id={id} base={detail.form} baseUpdatedAt={detail.updatedAt} />
      <MemoriesSection store={detail} />
      <UploadsSection store={detail} />
      <StoreActions id={id} name={clipTitle(detail.name)} />
    </Stack>
  )
}

// --- Mémoire : rendu ---

/** Le champ du nouveau chemin d'une mémoire, avec son enregistrement et ses refus. */
function RenameForm({ memory }: { memory: MemoryContent }) {
  const typed = read(renamePaths)[memory.id]
  const path = typed ?? memory.path
  const changed = path !== memory.path
  const invalid = changed && !isSafeMemoryPath(path)
  const busy = read(renaming)
  const failure = read(renameFailure)
  const refused = failure?.memoryId === memory.id ? failure : null
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" wrap>
        <Box grow minWidth={FIELD_MIN_WIDTH}>
          <Input label="Path" labelHidden disabled={busy} value={path} invalid={invalid} onChange={(value) => setRenamePath(memory.id, value)} />
        </Box>
        <Button variant="outline" size="sm" disabled={busy || !changed || invalid} onPress={() => run(() => renameMemory(memory, path))}>
          Save path
        </Button>
        <IconButton
          icon="close"
          label="Cancel rename"
          variant="ghost"
          size="sm"
          onPress={() => {
            setRenamePath(memory.id, null)
            set(renameFailure, null)
            set(renameOpen, null)
          }}
        />
      </Row>
      {invalid ? (
        <Text tone="danger" size="xs">
          {INVALID_MEMORY_PATH}
        </Text>
      ) : null}
      {refused !== null && refused.code === 'conflict' ? (
        <Callout tone="warning" title={CONFLICT_TITLE}>
          <Stack gap="sm">
            <Text size="sm">The content changed since you opened it. Reload drops the path you typed.</Text>
            <Row>
              <Button variant="outline" size="sm" disabled={busy} onPress={() => run(() => reloadMemory(memory))}>
                Reload
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {refused !== null && refused.code !== 'conflict' ? (
        <Callout tone="danger" title="Could not rename">
          <Text size="sm">{clipBytes(refused.message, ERROR_TEXT_LIMIT_BYTES).text}</Text>
        </Callout>
      ) : null}
    </Stack>
  )
}

/**
 * Les actions d'une mémoire ouverte, en une seule rangée : éditeur (✎, cycle de brouillon), remplacement par un fichier,
 * renommage (son champ s'ouvre dessous) et suppression (sa question s'ouvre dessous).
 */
export function MemoryActions({ memory }: { memory: MemoryContent }): OrcaNode {
  const draftRef = memoryDraft(memory.memoryStoreId, memory.id, memory.path)
  const reread = (): void => run(() => afterMemoryWrite(memory.memoryStoreId, memory.id))
  const deleteKey = `memory:${memory.id}:delete`
  return (
    <Stack gap="sm">
      <ActionRow
        actions={[
          { key: 'edit', icon: 'edit', label: 'Edit in editor', disabled: draftIsBusy(draftRef), onPress: () => startDraft(draftRef) },
          { key: 'replace', label: 'Replace…', onPress: () => replaceMemory(memory) },
          {
            key: 'rename',
            label: 'Rename',
            onPress: () => set(renameOpen, read(renameOpen) === memory.id ? null : memory.id)
          },
          { key: 'delete', label: 'Delete', tone: 'danger', onPress: () => askConfirmation(deleteKey) }
        ]}
      />
      <DraftControls draftRef={draftRef} label="Edit in editor" showOpen={false} onApplied={reread} onDiscarded={reread} />
      {read(renameOpen) === memory.id ? <RenameForm memory={memory} /> : null}
      <ConfirmPanel
        actionKey={deleteKey}
        question={`${deleteQuestion(memory.path)}${draftIsUnapplied(draftRef) ? KEPT_DRAFT_NOTE : ''}`}
        confirmLabel="Delete"
        onConfirm={() => deleteMemory(memory)}
      />
    </Stack>
  )
}
