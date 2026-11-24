// Section « Workspaces » de l'accueil : la liste des workspaces associés (un actif, un badge), l'ajout,
// la modification d'une ligne (nom, clé, console, retrait) et la bascule. Seul l'état replié de la section est persisté :
// une clé saisie reste en mémoire, dans son champ, nulle part ailleurs.
import { atom, Badge, Box, Button, Callout, IconButton, Input, plugin, read, set, shell, Stack, Text } from 'orca'
import { ConfirmInline } from '../blocks/confirm-inline'
import { GroupCard } from '../blocks/group-card'
import { SectionCollapsible } from '../blocks/section-collapsible'
import type { IconAction } from '../blocks/icon-action'
import type { ApiResult, WorkspaceInfo, WorkspaceRow } from '../protocol'
import { clipBytes } from '../shared/text'
import { resetAgentForms } from './agent-form'
import { loadConfigTab, resetConfigs } from './config-state'
import { restoreConfigView } from './config-views'
import { clearDraftState } from './drafts'
import { clearAllForms } from './form-state'
import { restoreNewSession } from './new-session'
import { resetResources } from './resource-state'
import { restoreOpenSession } from './session-view'
import {
  ERROR_TEXT_LIMIT_BYTES,
  homeFilters,
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

/** La section « Organisation » ouverte ou repliée : une préférence d'affichage, seul atome persisté du fichier. */
const sectionOpen = atom('workspacesOpen', true, { persist: 'plugin' })

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
 * courant est gardé), listes relues, filtres et saisies gardées oubliés (elles visent des objets de l'ancien workspace).
 */
export async function resetForWorkspace(): Promise<void> {
  set(nav, [{ view: 'home' }])
  resetSessionView(null)
  set(sessionRows, null)
  resetConfigs()
  resetResources()
  set(homeFilters, {})
  clearAllForms()
  resetAgentForms()
  clearDraftState()
  set(editing, null)
  resetEditFields()
  await Promise.all([loadSessions(), loadConfigTab()])
}

/** La clé de l'actif redevient utilisable sans changer de workspace : on relit ses listes, les saisies restent. */
async function reloadActive(): Promise<void> {
  set(sessionRows, null)
  resetConfigs()
  resetResources()
  await loadSessions()
  // Une vue de session restée au sommet de la pile (clé absente ou refusée au démarrage) n'a jamais chargé son fil.
  await Promise.all([restoreOpenSession(), restoreNewSession(), restoreConfigView(), loadConfigTab()])
}

/**
 * Prend l'identité fraîche du worker (sa réponse, ou `workspace.changed` quand un autre panneau a basculé) et relit ce
 * que le changement rend caduc. Sans changement d'actif, rien ne bouge : le même état arrive deux fois pour le panneau
 * qui a fait la demande.
 */
export async function adopt(info: WorkspaceInfo): Promise<void> {
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

/**
 * Le seul `Save` du détail : renomme si le nom a changé, puis remplace la clé si une clé est saisie, dans cet ordre.
 * Un refus s'affiche et garde la saisie ; ce qui a déjà été accepté reste (le nom renommé survit à une clé refusée).
 * Un refus du renommage arrête là : la clé n'est pas envoyée tant que le nom n'est pas réglé.
 */
async function saveWorkspace(row: WorkspaceRow): Promise<void> {
  set(editError, null)
  const name = (read(editName) ?? row.name).trim()
  const key = read(editKey).trim()
  if (name !== '' && name !== row.name) {
    const renamed = await send(
      () => plugin.request('workspaces.rename', { localId: row.localId, name }),
      (message) => set(editError, message)
    )
    if (!renamed) return
    set(editName, null)
  }
  if (key === '') return
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

function openInConsole(url: string): void {
  // L'appui sur ce bouton est le geste que `shell.openExternal` exige.
  run(async () => {
    await shell.openExternal(url)
  })
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

/** Largeur mini d'un champ du formulaire d'ajout : en dessous, les deux champs passent l'un sous l'autre. */
const FIELD_MIN_WIDTH = 140

/**
 * Le formulaire en ligne du `+`, posé dans la carte sous la dernière ligne : `Name` et `API key` côte à côte quand la
 * largeur le permet (retour à la ligne sinon), puis `Add` (action principale) et `Cancel`. Composé en natif : aucun bloc
 * du kit ne dessine deux champs qui se replient.
 */
function AddForm() {
  const working = read(busy)
  return (
    <Box direction="column" gap="sm" paddingY="sm">
      {[
        <Box key="fields" direction="row" wrap gap="sm">
          {[
            <Box key="name" grow width={FIELD_MIN_WIDTH}>
              <Input label="Name" value={read(addName)} onChange={(value) => set(addName, value)} />
            </Box>,
            <Box key="key" grow width={FIELD_MIN_WIDTH}>
              <Input
                label="API key"
                type="password"
                placeholder="sk-ant-..."
                value={read(addKey)}
                onChange={(value) => set(addKey, value)}
                onSubmit={() => run(addWorkspace)}
              />
            </Box>
          ]}
        </Box>,
        <ErrorLine key="error" message={read(addError)} />,
        <Box key="actions" direction="row" wrap gap="sm">
          {[
            <Button
              key="add"
              variant="solid"
              tone="accent"
              size="sm"
              onPress={() => run(addWorkspace)}
              disabled={working || !read(addName).trim() || !read(addKey).trim()}
            >
              Add
            </Button>,
            <Button key="cancel" variant="outline" size="sm" onPress={closeAddForm}>
              Cancel
            </Button>
          ]}
        </Box>
      ]}
    </Box>
  )
}

/**
 * Le détail ✎ d'une ligne : nom, nouvelle clé, un seul `Save`, puis `Console` et `Remove`. Sur une clé refusée ou
 * manquante, le détail s'ouvre seul et l'aide de la clé le dit.
 */
function WorkspaceDetail({ row, needsFix }: { row: WorkspaceRow; needsFix: boolean }) {
  const working = read(busy)
  const name = read(editName) ?? row.name
  const nameChanged = name.trim() !== '' && name.trim() !== row.name
  const changed = nameChanged || read(editKey).trim() !== ''
  const save = () => {
    if (changed) run(() => saveWorkspace(row))
  }
  return (
    <Stack gap="sm">
      <Input label="Name" value={name} onChange={(value) => set(editName, value)} onSubmit={save} />
      <Stack gap="xs">
        <Input
          label="New API key"
          type="password"
          placeholder="sk-ant-..."
          value={read(editKey)}
          onChange={(value) => set(editKey, value)}
          onSubmit={save}
        />
        <Text muted size="xs">
          {needsFix ? 'Paste a new key for this workspace.' : 'Leave empty to keep the current key.'}
        </Text>
      </Stack>
      <ErrorLine message={read(editError)} />
      <Box direction="row" wrap gap="sm">
        <Button variant="solid" tone="accent" size="sm" disabled={working || !changed} onPress={save}>
          Save
        </Button>
      </Box>
      <Box direction="row" wrap align="center" gap="sm">
        {[
          row.workspaceId ? (
            <Button
              key="console"
              variant="outline"
              size="sm"
              icon="open-external"
              onPress={() => openInConsole(`https://platform.claude.com/workspaces/${row.workspaceId}/agents`)}
            >
              Console
            </Button>
          ) : null,
          read(confirmingRemove) ? null : (
            <Button key="remove" variant="outline" tone="danger" size="sm" onPress={() => set(confirmingRemove, true)}>
              Remove
            </Button>
          )
        ]}
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
  )
}

function statusOf(row: WorkspaceRow, info: WorkspaceInfo): { label: string; tone: 'danger' | 'warning' | 'success' } | undefined {
  if (!row.active) return undefined
  if (info.keyRejected) return { label: 'Key rejected', tone: 'danger' }
  if (!info.hasKey) return { label: 'Key missing', tone: 'warning' }
  return { label: 'Active', tone: 'success' }
}

/**
 * Une ligne de la carte, composée en natif : `ItemRow` passe son badge à la ligne quand la place manque, d'où des hauteurs
 * inégales. Ici deux lignes fixes, donc une hauteur constante à 220 comme à 360 : le nom et les actions, puis le badge
 * d'état (s'il y en a un) et l'identifiant en sourdine.
 */
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
    <Box direction="column" gap="xs" paddingY="sm">
      {/* Une seule liste plate et entièrement clée à chaque niveau : Orca ignore les clés d'un tableau imbriqué parmi d'autres enfants. */}
      {[
        <Box key="head" direction="row" align="center" gap="sm">
          {[
            <Box key="name" grow minWidth={0}>
              <Text weight="semibold" truncate>
                {name}
              </Text>
            </Box>,
            <Box key="actions" direction="row" align="center" gap="xs" shrink={false}>
              {actions.map((action) => (
                <Box key={`action-${action.key}`} shrink={false}>
                  <IconButton
                    icon={action.icon}
                    label={action.label}
                    variant={action.active ? 'outline' : 'ghost'}
                    size="sm"
                    onPress={action.onPress}
                  />
                </Box>
              ))}
            </Box>
          ]}
        </Box>,
        <Box key="meta" direction="row" align="center" gap="sm">
          {[
            status ? (
              <Box key="status" shrink={false}>
                <Badge tone={status.tone}>{status.label}</Badge>
              </Box>
            ) : null,
            <Box key="id" grow minWidth={0}>
              <Text muted size="xs" truncate>
                {row.workspaceId === null ? 'Workspace unknown' : clipName(row.workspaceId)}
              </Text>
            </Box>
          ]}
        </Box>,
        opened ? (
          <Box key="detail" paddingY="sm">
            <WorkspaceDetail row={row} needsFix={row.active && !isUsable(info)} />
          </Box>
        ) : null
      ]}
    </Box>
  )
}

/**
 * La section : « Organisation » repliable, le `+` à droite de son en-tête, et dans la carte la liste des workspaces (ou le
 * formulaire de la première clé), puis le formulaire d'ajout après un filet quand `+` l'ouvre. Fermée, elle résume le
 * workspace actif ; `+` la rouvre.
 */
export function WorkspacesSection({ info }: { info: WorkspaceInfo }) {
  if (info.workspaces.length === 0) return <FirstKeyForm />
  const open = read(sectionOpen)
  const active = info.workspaces.find((row) => row.active)
  return (
    <Box direction="row" align="start" gap="sm">
      <Box key="section" grow minWidth={0}>
        <SectionCollapsible
          title="Organisation"
          summary={active ? clipName(active.name) : undefined}
          open={open}
          onChange={(next) => set(sectionOpen, next)}
        >
          <GroupCard
            rows={[
              ...info.workspaces.map((row) => ({ key: row.localId, row: <WorkspaceLine row={row} info={info} /> })),
              read(addOpen) ? { key: 'add-form', row: <AddForm /> } : null
            ]}
          />
        </SectionCollapsible>
      </Box>
      <Box key="add" shrink={false}>
        <IconButton icon="add" label="Add workspace" variant="ghost" onPress={openAddFromHeader} />
      </Box>
    </Box>
  )
}

function openAddFromHeader(): void {
  set(sectionOpen, true)
  openAddForm()
}
