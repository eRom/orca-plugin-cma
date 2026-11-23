// Section « Anthropic workspace » de l'accueil : la liste des workspaces associés (un actif, un badge), l'ajout,
// la modification d'une ligne (nom, clé, console, retrait) et la bascule. Aucun atome de ce fichier n'est persisté :
// une clé saisie reste en mémoire, dans son champ, nulle part ailleurs.
import { atom, Box, Button, Callout, IconButton, Input, Link, plugin, read, set, Stack, Text } from 'orca'
import { ConfirmInline } from '../blocks/confirm-inline'
import { GroupCard } from '../blocks/group-card'
import type { IconAction } from '../blocks/icon-action'
import { ItemRow } from '../blocks/item-row'
import type { ApiResult, WorkspaceInfo, WorkspaceRow } from '../protocol'
import { clipBytes } from '../shared/text'
import { loadConfigTab, resetConfigs } from './config-state'
import { restoreConfigView } from './config-views'
import { clearDraftState } from './drafts'
import { clearAllForms } from './form-state'
import { restoreNewSession } from './new-session'
import { restoreOpenSession } from './session-view'
import {
  ERROR_TEXT_LIMIT_BYTES,
  homeFilter,
  loadSessions,
  nav,
  notice,
  resetSessionView,
  run,
  sessionRows,
  workspace
} from './state'

/** Plafond du nom d'un workspace à l'écran : un libellé de plus de 1 Kio fait refuser le rendu. */
const NAME_LIMIT_BYTES = 200
const DEFAULT_NAME = 'Default'

// --- État éphémère des formulaires ---

/** Vrai pendant un appel au worker : un second appui ne part pas (un ajout doublé serait refusé en doublon). */
const busy = atom(false)

const addOpen = atom(false)
const addName = atom('')
const addKey = atom('')
const addError = atom<string | null>(null)

/** Le formulaire de la première clé, quand aucun workspace n'est associé. */
const firstName = atom(DEFAULT_NAME)
const firstKey = atom('')
const firstError = atom<string | null>(null)

/** Le ✎ ouvert : `null` = le choix par défaut (la ligne active s'ouvre seule quand sa clé manque ou est refusée) ; `localId: null` = tout fermé. */
const editing = atom<{ localId: string | null } | null>(null)
/** Nom en cours de saisie ; `null` tant qu'on n'y a pas touché (la ligne donne le nom). */
const editName = atom<string | null>(null)
const editKey = atom('')
const editError = atom<string | null>(null)
const confirmingRemove = atom(false)

// --- Lecture de l'identité ---

const activeLocalIdOf = (info: WorkspaceInfo | null): string | null => info?.workspaces.find((row) => row.active)?.localId ?? null
const isUsable = (info: WorkspaceInfo | null): boolean => info !== null && info.hasKey && !info.keyRejected

/** La ligne dont le détail est ouvert. */
function openedLocalId(info: WorkspaceInfo): string | null {
  const chosen = read(editing)
  if (chosen !== null) return chosen.localId
  return isUsable(info) ? null : activeLocalIdOf(info)
}

function resetEditFields(): void {
  set(editName, null)
  set(editKey, '')
  set(editError, null)
  set(confirmingRemove, false)
}

// --- À la bascule ---

/**
 * Le workspace actif a changé : tout ce que le panneau montre venait de l'ancien. Retour à l'accueil (l'onglet
 * courant est gardé), listes relues, filtre et saisies gardées oubliés (elles visent des objets de l'ancien workspace).
 */
export async function resetForWorkspace(): Promise<void> {
  set(nav, [{ view: 'home' }])
  resetSessionView(null)
  set(sessionRows, null)
  resetConfigs()
  set(homeFilter, '')
  clearAllForms()
  clearDraftState()
  set(editing, null)
  resetEditFields()
  await Promise.all([loadSessions(), loadConfigTab()])
}

/** La clé de l'actif redevient utilisable sans changer de workspace : on relit ses listes, les saisies restent. */
async function reloadActive(): Promise<void> {
  set(sessionRows, null)
  resetConfigs()
  await loadSessions()
  // Une vue de session restée au sommet de la pile (clé absente ou refusée au démarrage) n'a jamais chargé son fil.
  await Promise.all([restoreOpenSession(), restoreNewSession(), restoreConfigView(), loadConfigTab()])
}

/** Prend la réponse du worker (toujours l'identité fraîche) et relit ce que le changement rend caduc. */
async function adopt(info: WorkspaceInfo): Promise<void> {
  const previous = read(workspace)
  set(workspace, info)
  if (activeLocalIdOf(info) !== activeLocalIdOf(previous)) {
    await resetForWorkspace()
  } else if (!isUsable(previous) && isUsable(info)) {
    await reloadActive()
  }
}

/** Envoie une requête de workspace ; un refus va à `onRefused` (dans le formulaire qui l'a envoyée). Vrai si le worker a accepté. */
async function send(call: () => Promise<ApiResult<WorkspaceInfo>>, onRefused: (message: string) => void): Promise<boolean> {
  if (read(busy)) return false
  set(busy, true)
  try {
    const result = await call()
    if (!result.ok) {
      onRefused(result.error)
      return false
    }
    await adopt(result.value)
    return true
  } finally {
    set(busy, false)
  }
}

// --- Gestes ---

async function activate(localId: string): Promise<void> {
  await send(
    () => plugin.request('workspaces.activate', { localId }),
    (message) => set(notice, message)
  )
}

async function addWorkspace(): Promise<void> {
  set(addError, null)
  const name = read(addName).trim()
  const key = read(addKey).trim()
  const added = await send(
    () => plugin.request('workspaces.add', { name, key }),
    (message) => set(addError, message)
  )
  if (added) closeAddForm()
}

function openAddForm(): void {
  closeAddForm()
  set(addOpen, true)
}

function closeAddForm(): void {
  set(addOpen, false)
  set(addName, '')
  set(addKey, '')
  set(addError, null)
}

async function addFirstWorkspace(): Promise<void> {
  set(firstError, null)
  const name = read(firstName).trim()
  const key = read(firstKey).trim()
  const added = await send(
    () => plugin.request('workspaces.add', { name, key }),
    (message) => set(firstError, message)
  )
  if (added) {
    set(firstKey, '')
    set(firstName, DEFAULT_NAME)
  }
}

async function renameWorkspace(row: WorkspaceRow): Promise<void> {
  set(editError, null)
  const name = (read(editName) ?? row.name).trim()
  const renamed = await send(
    () => plugin.request('workspaces.rename', { localId: row.localId, name }),
    (message) => set(editError, message)
  )
  if (renamed) set(editName, null)
}

async function replaceKey(row: WorkspaceRow): Promise<void> {
  set(editError, null)
  const key = read(editKey).trim()
  const replaced = await send(
    () => plugin.request('workspaces.replaceKey', { localId: row.localId, key }),
    (message) => set(editError, message)
  )
  if (replaced) {
    set(editKey, '')
    // La ligne n'a plus de raison de rester ouverte d'office : la clé est bonne.
    set(editing, null)
  }
}

async function removeWorkspace(row: WorkspaceRow): Promise<void> {
  set(confirmingRemove, false)
  set(editError, null)
  const removed = await send(
    () => plugin.request('workspaces.remove', { localId: row.localId }),
    (message) => set(editError, message)
  )
  if (removed) {
    set(editing, null)
    resetEditFields()
  }
}

/** ✎ : ouvre le détail de la ligne, ou le ferme si c'est déjà lui ; un seul à la fois. */
function toggleEdit(info: WorkspaceInfo, row: WorkspaceRow): void {
  set(editing, { localId: openedLocalId(info) === row.localId ? null : row.localId })
  resetEditFields()
}

// --- Vues ---

const clipName = (name: string): string => clipBytes(name, NAME_LIMIT_BYTES).text
const clipError = (message: string): string => clipBytes(message, ERROR_TEXT_LIMIT_BYTES).text

function ErrorLine({ message }: { message: string | null }) {
  return message === null ? null : <Callout tone="danger" title={clipError(message)} />
}

/** Aucun workspace associé : la clé du premier, avec son nom (prérempli « Default »). */
export function FirstKeyForm() {
  const working = read(busy)
  return (
    <Stack gap="sm">
      <Callout tone="warning" title="Add your Anthropic API key">
        <Stack gap="sm">
          <Text muted size="sm">
            Orca stores it encrypted in your OS keyring. Only this plugin's worker uses it.
          </Text>
          <Input label="Name" value={read(firstName)} onChange={(value) => set(firstName, value)} />
          <Input
            label="API key"
            type="password"
            placeholder="sk-ant-..."
            value={read(firstKey)}
            onChange={(value) => set(firstKey, value)}
            onSubmit={() => run(addFirstWorkspace)}
          />
          <Button
            variant="solid"
            tone="accent"
            onPress={() => run(addFirstWorkspace)}
            disabled={working || !read(firstName).trim() || !read(firstKey).trim()}
          >
            Save key
          </Button>
        </Stack>
      </Callout>
      <ErrorLine message={read(firstError)} />
    </Stack>
  )
}

/** Le formulaire en ligne du `+` : un nom, une clé, `Add` (action principale) et `Cancel`. */
function AddForm() {
  const working = read(busy)
  return (
    <Box border radius="md" padding="sm">
      <Stack gap="sm">
        <Input label="Name" value={read(addName)} onChange={(value) => set(addName, value)} />
        <Input
          label="API key"
          type="password"
          placeholder="sk-ant-..."
          value={read(addKey)}
          onChange={(value) => set(addKey, value)}
          onSubmit={() => run(addWorkspace)}
        />
        <ErrorLine message={read(addError)} />
        <Box direction="row" wrap gap="sm">
          <Button
            variant="solid"
            tone="accent"
            size="sm"
            onPress={() => run(addWorkspace)}
            disabled={working || !read(addName).trim() || !read(addKey).trim()}
          >
            Add
          </Button>
          <Button variant="outline" size="sm" onPress={closeAddForm}>
            Cancel
          </Button>
        </Box>
      </Stack>
    </Box>
  )
}

/** Le détail ✎ d'une ligne : renommer, remplacer la clé, ouvrir la console, retirer. */
function WorkspaceDetail({ row, needsFix }: { row: WorkspaceRow; needsFix: boolean }) {
  const working = read(busy)
  const name = read(editName) ?? row.name
  const nameChanged = name.trim() !== '' && name.trim() !== row.name
  return (
    <Box paddingY="sm">
      <Stack gap="sm">
        <Input label="Name" value={name} onChange={(value) => set(editName, value)} onSubmit={() => nameChanged && run(() => renameWorkspace(row))} />
        <Box direction="row" wrap gap="sm">
          <Button variant="outline" size="sm" disabled={working || !nameChanged} onPress={() => run(() => renameWorkspace(row))}>
            Save
          </Button>
        </Box>
        <Input
          label="Replace key"
          type="password"
          placeholder="sk-ant-..."
          value={read(editKey)}
          onChange={(value) => set(editKey, value)}
          onSubmit={() => run(() => replaceKey(row))}
        />
        <Box direction="row" wrap gap="sm">
          {/* Sur une ligne dont la clé manque ou est refusée, enregistrer la clé est le geste attendu. */}
          <Button
            variant={needsFix ? 'solid' : 'outline'}
            {...(needsFix ? { tone: 'accent' as const } : {})}
            size="sm"
            disabled={working || !read(editKey).trim()}
            onPress={() => run(() => replaceKey(row))}
          >
            Save key
          </Button>
        </Box>
        <ErrorLine message={read(editError)} />
        <Box direction="row" wrap align="center" gap="sm">
          {row.workspaceId ? <Link href={`https://platform.claude.com/workspaces/${row.workspaceId}/agents`}>Console</Link> : null}
          {read(confirmingRemove) ? null : (
            <Button variant="ghost" tone="danger" size="sm" onPress={() => set(confirmingRemove, true)}>
              Remove
            </Button>
          )}
        </Box>
        {read(confirmingRemove) ? (
          <ConfirmInline
            question={`Remove ${clipName(row.name)}? Its key is deleted from this Mac.`}
            confirmLabel="Remove"
            onCancel={() => set(confirmingRemove, false)}
            onConfirm={() => run(() => removeWorkspace(row))}
          />
        ) : null}
      </Stack>
    </Box>
  )
}

function statusOf(row: WorkspaceRow, info: WorkspaceInfo): { label: string; tone: 'danger' | 'warning' | 'success' } | undefined {
  if (!row.active) return undefined
  if (info.keyRejected) return { label: 'Key rejected', tone: 'danger' }
  if (!info.hasKey) return { label: 'Key missing', tone: 'warning' }
  return { label: 'Active', tone: 'success' }
}

function WorkspaceLine({ row, info }: { row: WorkspaceRow; info: WorkspaceInfo }) {
  const opened = openedLocalId(info) === row.localId
  const name = clipName(row.name)
  const status = statusOf(row, info)
  const actions: IconAction[] = [
    ...(row.active
      ? []
      : [{ key: 'use', icon: 'check' as const, label: 'Use this workspace', onPress: () => run(() => activate(row.localId)) }]),
    { key: 'edit', icon: 'edit', label: `Edit ${name}`, active: opened, onPress: () => toggleEdit(info, row) }
  ]
  return (
    <Stack gap="xs">
      <ItemRow title={name} subtitle={row.workspaceId ?? 'Workspace unknown'} {...(status ? { status } : {})} actions={actions} />
      {opened ? <WorkspaceDetail row={row} needsFix={row.active && !isUsable(info)} /> : null}
    </Stack>
  )
}

/** La section : la liste des workspaces (ou le formulaire de la première clé), puis le formulaire d'ajout quand `+` l'ouvre. */
export function WorkspacesSection({ info }: { info: WorkspaceInfo }) {
  if (info.workspaces.length === 0) return <FirstKeyForm />
  return (
    <Stack gap="sm">
      <GroupCard
        title="Anthropic workspace"
        trailing={<IconButton icon="add" label="Add workspace" variant="outline" onPress={openAddForm} />}
        rows={info.workspaces.map((row) => ({ key: row.localId, row: <WorkspaceLine row={row} info={info} /> }))}
      />
      {read(addOpen) ? <AddForm /> : null}
    </Stack>
  )
}
