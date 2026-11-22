// Banques de mémoire et mémoires : le formulaire d'une banque (création, modification, archivage,
// suppression), sa liste de mémoires avec « New memory », et les actions d'une mémoire ouverte
// (contenu par brouillon, renommage, suppression). La saisie d'une banque est gardée par `form-state` ;
// le reste de l'état (chemin à renommer, nouvelle mémoire en cours) est éphémère.
import {
  atom,
  Button,
  Callout,
  Code,
  Input,
  List,
  ListItem,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type OrcaNode
} from 'orca'
import type { ApiResult, DraftRef, MemoryContent, MemoryStoreDetail, MemoryStoreForm } from '../protocol'
import { INVALID_MEMORY_PATH, isSafeMemoryPath } from '../shared/memory-path'
import { clipBytes } from '../shared/text'
import { archiveQuestion, ConfirmAction, deleteQuestion } from './confirm'
import { configDetail, loadConfigs, loadDetail, loadMemory, memoryDraft, openConfig, openMemory, RENDER_ROW_CAP } from './config-state'
import { DraftControls, draftHasFlow, loadDraftControls } from './drafts'
import { clearForm, editForm, formConflict, formKey, isTouched, readForm, touchField } from './form-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popIfTop, popView, run } from './state'

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafond d'un nom ou d'un chemin repris dans un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200
const PATH_HELP = 'Starts with /, for example /notes/today.md'

const clipTitle = (text: string): string => clipBytes(text, TITLE_LIMIT_BYTES).text

function emptyForm(): MemoryStoreForm {
  return { name: '', description: '' }
}

// --- État éphémère ---

/** Vrai pendant l'enregistrement d'une banque : un double appui ne part pas deux fois. */
const saving = atom(false)
/** Refus de l'enregistrement d'une banque (hors conflit), avec le formulaire concerné. */
const saveFailure = atom<{ key: string; message: string } | null>(null)

/** Où en est la nouvelle mémoire d'une banque : le chemin demandé, puis le brouillon, puis son succès. */
type NewMemoryEntry = { phase: 'asking' | 'editing' | 'applied'; path: string }
/** Par identifiant de banque. */
const newMemory = atom<Record<string, NewMemoryEntry>>({})

/** Chemins tapés dans le champ « Path » d'une mémoire ouverte, par identifiant de mémoire ; absent : le chemin actuel. */
const renamePaths = atom<Record<string, string>>({})
/** Vrai pendant un renommage. */
const renaming = atom(false)
/** Refus d'un renommage, avec la mémoire concernée. */
const renameFailure = atom<{ memoryId: string; code: string; message: string } | null>(null)

function discardForm(key: string): void {
  clearForm(key)
  if (read(saveFailure)?.key === key) set(saveFailure, null)
}

function setNewMemory(storeId: string, entry: NewMemoryEntry | null): void {
  update(newMemory, (entries) => {
    const { [storeId]: _dropped, ...rest } = entries
    return entry === null ? rest : { ...rest, [storeId]: entry }
  })
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

/** Archive ou supprime la banque, puis revient à l'accueil et relit la liste. Un refus de l'API remonte à `ConfirmAction`. */
async function removeStore(key: string, id: string, call: () => Promise<ApiResult<null>>): Promise<void> {
  const result = await call()
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'memory_store' && entry.id === id)
  await loadConfigs('memory_store')
}

/** Relit la liste puis le détail de la banque : après l'application d'une nouvelle mémoire. */
async function reloadStore(storeId: string): Promise<void> {
  await loadConfigs('memory_store')
  await loadDetail('memory_store', storeId)
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

/** Supprime la mémoire, puis revient au détail de sa banque relu. Un refus de l'API remonte à `ConfirmAction`. */
async function deleteMemory(memory: MemoryContent): Promise<void> {
  const result = await plugin.request('resource.delete', { kind: 'memory', memoryStoreId: memory.memoryStoreId, id: memory.id })
  if (!result.ok) throw new Error(result.error)
  setRenamePath(memory.id, null)
  const closed = popIfTop((entry) => entry.view === 'memory' && entry.memoryId === memory.id)
  await loadConfigs('memory_store')
  if (closed) await loadDetail('memory_store', memory.memoryStoreId)
}

function goBack(): void {
  update(nav, popView)
}

// --- Banque : rendu ---

type BodyProps = { id: string | null; base: MemoryStoreForm; baseUpdatedAt: string | null; name: string }

function MemoryStoreFormBody({ id, base, baseUpdatedAt, name }: BodyProps) {
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
    <Stack gap="md">
      {dirty ? (
        <Callout tone="accent">
          <Row gap="sm" align="center" justify="between" wrap>
            <Text size="sm">Unsaved changes</Text>
            <Button variant="ghost" size="sm" onPress={() => discardForm(key)}>
              Discard
            </Button>
          </Row>
        </Callout>
      ) : null}
      {conflict && id !== null ? (
        <Callout tone="warning" title={CONFLICT_TITLE}>
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
      ) : null}
      {failed?.key === key ? (
        <Callout tone="danger" title="Could not save">
          <Text size="sm">{clipBytes(failed.message, ERROR_TEXT_LIMIT_BYTES).text}</Text>
        </Callout>
      ) : null}
      <Input
        label="Name"
        disabled={busy}
        value={form.name}
        invalid={nameInvalid}
        onChange={(value) => {
          touchField(key, 'name')
          change({ name: value })
        }}
      />
      <Input label="Description" disabled={busy} placeholder="Optional" value={form.description} onChange={(value) => change({ description: value })} />
      <Row gap="sm" align="center" wrap>
        <Button disabled={busy || nameMissing || (id !== null && !dirty)} onPress={() => run(() => saveForm(target, false))}>
          {id === null ? 'Create' : 'Save'}
        </Button>
        {id !== null ? (
          <>
            <ConfirmAction
              actionKey={`memory_store:${id}:archive`}
              label="Archive"
              question={archiveQuestion(name)}
              confirmLabel="Archive"
              disabled={busy}
              onConfirm={() => removeStore(key, id, () => plugin.request('resource.archive', { kind: 'memory_store', id }))}
            />
            <ConfirmAction
              actionKey={`memory_store:${id}:delete`}
              label="Delete"
              question={deleteQuestion(name)}
              confirmLabel="Delete"
              disabled={busy}
              onConfirm={() => removeStore(key, id, () => plugin.request('resource.delete', { kind: 'memory_store', id }))}
            />
          </>
        ) : null}
      </Row>
    </Stack>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** « New memory » : demande le chemin, puis rend les contrôles du brouillon d'une mémoire pas encore créée. */
function NewMemory({ store }: { store: MemoryStoreDetail }) {
  const entry = read(newMemory)[store.id]
  const fieldKey = `memory:new:${store.id}`
  if (entry === undefined || (entry.phase === 'applied' && !draftHasFlow(newMemoryRef(store.id, entry.path)))) {
    return (
      <Row>
        <Button icon="add" onPress={() => setNewMemory(store.id, { phase: 'asking', path: '' })}>
          New memory
        </Button>
      </Row>
    )
  }
  if (entry.phase === 'asking') {
    const invalid = entry.path !== '' && !isSafeMemoryPath(entry.path)
    const proceed = (): void => {
      if (entry.path === '' || invalid) return
      setNewMemory(store.id, { phase: 'editing', path: entry.path })
      run(() => loadDraftControls(newMemoryRef(store.id, entry.path)))
    }
    return (
      <Stack gap="sm">
        <Input
          label="Path"
          value={entry.path}
          invalid={invalid && isTouched(fieldKey, 'path')}
          onChange={(value) => {
            touchField(fieldKey, 'path')
            setNewMemory(store.id, { phase: 'asking', path: value })
          }}
          onSubmit={proceed}
        />
        {invalid && isTouched(fieldKey, 'path') ? (
          <Text tone="danger" size="sm">
            {INVALID_MEMORY_PATH}
          </Text>
        ) : (
          <Text muted size="xs">
            {PATH_HELP}
          </Text>
        )}
        <Row gap="sm" wrap>
          <Button disabled={entry.path === '' || invalid} onPress={proceed}>
            Continue
          </Button>
          <Button variant="ghost" size="sm" onPress={() => setNewMemory(store.id, null)}>
            Cancel
          </Button>
        </Row>
      </Stack>
    )
  }
  const ref = newMemoryRef(store.id, entry.path)
  return (
    <Stack gap="sm">
      <Row gap="sm" align="center" wrap>
        <Code>{clipTitle(entry.path)}</Code>
        <Button variant="ghost" size="sm" onPress={() => setNewMemory(store.id, null)}>
          Close
        </Button>
      </Row>
      <DraftControls
        draftRef={ref}
        label="Edit content"
        onApplied={() => {
          setNewMemory(store.id, { phase: 'applied', path: entry.path })
          run(() => reloadStore(store.id))
        }}
      />
    </Stack>
  )
}

function newMemoryRef(memoryStoreId: string, path: string): DraftRef {
  return { kind: 'memory', memoryStoreId, memoryId: null, path }
}

function MemoriesSection({ store }: { store: MemoryStoreDetail }) {
  return (
    <Stack gap="sm">
      <Text size="sm" weight="medium">
        Memories
      </Text>
      <NewMemory store={store} />
      {store.memories.length === 0 ? (
        <Text muted size="sm">
          No memories yet.
        </Text>
      ) : (
        <List label="Memories">
          {store.memories.slice(0, RENDER_ROW_CAP).map((memory) => {
            const at = Date.parse(memory.updatedAt)
            return (
              <ListItem key={memory.id} title={clipTitle(memory.path)} description={formatSize(memory.sizeBytes)} onPress={() => openMemory(store.id, memory.id)}>
                {Number.isNaN(at) ? null : <RelativeTime at={at} format="short" muted />}
              </ListItem>
            )
          })}
        </List>
      )}
      {store.memories.length > RENDER_ROW_CAP ? (
        <Text muted size="xs">
          {`Showing the first ${RENDER_ROW_CAP} of ${store.memories.length}. Open in Console for the rest.`}
        </Text>
      ) : null}
    </Stack>
  )
}

/** `id` null : la création ; sinon la banque chargée dans le détail ouvert. */
export function MemoryStoreFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <Row gap="sm" align="center" justify="between" wrap>
          <Button variant="ghost" size="sm" onPress={goBack}>
            ‹ Back
          </Button>
        </Row>
        <Text weight="semibold">New memory store</Text>
        <MemoryStoreFormBody id={null} base={emptyForm()} baseUpdatedAt={null} name="" />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'memory_store' || detail.id !== id) return <Spinner label="Loading details" />
  return (
    <Stack gap="lg">
      <MemoryStoreFormBody id={id} base={detail.form} baseUpdatedAt={detail.updatedAt} name={clipTitle(detail.name)} />
      <MemoriesSection store={detail} />
    </Stack>
  )
}

// --- Mémoire : rendu ---

/** Les actions d'une mémoire ouverte : contenu (brouillon), chemin (renommage), suppression. */
export function MemoryActions({ memory }: { memory: MemoryContent }): OrcaNode {
  const typed = read(renamePaths)[memory.id]
  const path = typed ?? memory.path
  const changed = path !== memory.path
  const invalid = changed && !isSafeMemoryPath(path)
  const busy = read(renaming)
  const failure = read(renameFailure)
  const refused = failure?.memoryId === memory.id ? failure : null
  return (
    <Stack gap="md">
      <DraftControls
        draftRef={memoryDraft(memory.memoryStoreId, memory.id, memory.path)}
        label="Edit content"
        onApplied={() => run(() => afterMemoryWrite(memory.memoryStoreId, memory.id))}
      />
      <Stack gap="sm">
        <Input label="Path" disabled={busy} value={path} invalid={invalid} onChange={(value) => setRenamePath(memory.id, value)} />
        {invalid ? (
          <Text tone="danger" size="sm">
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
        <Row gap="sm" align="center" wrap>
          <Button variant="outline" size="sm" disabled={busy || !changed || invalid} onPress={() => run(() => renameMemory(memory, path))}>
            Rename
          </Button>
          <ConfirmAction
            actionKey={`memory:${memory.id}:delete`}
            label="Delete"
            question={deleteQuestion(memory.path)}
            confirmLabel="Delete"
            disabled={busy}
            onConfirm={() => deleteMemory(memory)}
          />
        </Row>
      </Stack>
    </Stack>
  )
}
