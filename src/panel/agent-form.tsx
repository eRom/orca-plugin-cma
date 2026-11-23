// Formulaire d'un agent : création et modification. La saisie en cours est gardée par `form-state` (atome persisté,
// avec la base et la version sur lesquelles elle a été commencée). « Review changes » met l'écriture en attente côté
// worker (`agent.prepareForm`), montre les changements, puis « Confirm » l'envoie (`write.commit`) ; « Create »
// crée l'agent d'un seul geste. Le prompt, les skills, `multiagent` et les réglages par outil MCP restent en lecture
// seule, avec un renvoi vers le brouillon YAML. Les blocs du kit (`src/blocks/`) sont copiés tels quels.
import {
  atom,
  Box,
  Button,
  Callout,
  CodeView,
  IconButton,
  Input,
  KeyValue,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  Textarea,
  update,
  type OrcaNode
} from 'orca'
import { EmptyView } from '../blocks/empty-view'
import { GroupCard } from '../blocks/group-card'
import { ItemRow } from '../blocks/item-row'
import { SectionCollapsible } from '../blocks/section-collapsible'
import {
  AGENT_EFFORTS,
  BUILTIN_TOOLS,
  type AgentDetail,
  type AgentEffort,
  type AgentForm,
  type AgentToolsForm,
  type ApiErrorCode,
  type Committed,
  type DraftRef,
  type PreparedWrite,
  type ToolPolicy
} from '../protocol'
import { clipBytes } from '../shared/text'
import { ChangesPreview } from './changes'
import { agentModels, configDetail, configDetailError, loadConfigs, loadDetail, openConfig } from './config-state'
import { archiveQuestion, askConfirmation, ConfirmPanel } from './confirm'
import { carryDraftOutcome, DraftControls, draftIsBusy, startDraft } from './drafts'
import { clearForm, editForm, formKey, isTouched, readForm, touchField } from './form-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popIfTop, popView, run } from './state'

/** Mention affichée sous un texte coupé côté worker. */
export const TRUNCATED_NOTICE = 'Truncated, open in Console for the full text'

export const POLICY_LABELS: Record<ToolPolicy, string> = {
  always_allow: 'always allow',
  always_ask: 'always ask',
  auto: 'auto'
}

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafond d'un nom repris dans un libellé : un libellé de plus de 1 Kio fait refuser le rendu. */
const TITLE_LIMIT_BYTES = 200
const DESCRIPTION_LIMIT_BYTES = 300
/** Plafond d'un texte long : sous les 16 Kio qu'Orca accepte par `Text`, avec marge. */
const LONG_TEXT_LIMIT_BYTES = 4_000
/** Largeur minimale d'un champ qui partage sa ligne : en dessous, le suivant passe dessous. */
const FIELD_MIN_WIDTH = 140
/** Valeur du choix « Default » des listes : il envoie `null`. */
const DEFAULT_CHOICE = 'default'
/** Les refus qui se corrigent par un geste de la personne s'affichent en avertissement. */
const WARNING_CODES: readonly ApiErrorCode[] = ['nothing_to_apply', 'expired', 'invalid']
const MAX_RENDERED_SERVERS = 200

const POLICIES: readonly ToolPolicy[] = ['always_allow', 'always_ask', 'auto']
const POLICY_OPTIONS = POLICIES.map((value) => ({ value, label: POLICY_LABELS[value] }))
const EFFORT_OPTIONS = AGENT_EFFORTS.map((value) => ({ value, label: value }))
/** « Default » n'existe qu'à la création : sur une mise à jour, omettre l'effort garde la valeur stockée de l'agent. */
const NEW_EFFORT_OPTIONS = [{ value: DEFAULT_CHOICE, label: 'Default' }, ...EFFORT_OPTIONS]
const ENABLED_OPTIONS = [
  { value: DEFAULT_CHOICE, label: 'Default' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' }
]
const TOOL_POLICY_OPTIONS = [{ value: DEFAULT_CHOICE, label: 'Default' }, ...POLICY_OPTIONS]

const clipTitle = (text: string): string => clipBytes(text, TITLE_LIMIT_BYTES).text

const asPolicy = (value: string): ToolPolicy | null => POLICIES.find((policy) => policy === value) ?? null
const asEffort = (value: string): AgentEffort | null => AGENT_EFFORTS.find((effort) => effort === value) ?? null

/** Le brouillon YAML d'un agent (`null` : un nouvel agent). */
export const agentDraft = (agentId: string | null): DraftRef => ({ kind: 'agent', agentId })

function defaultTools(): AgentToolsForm {
  return { enabled: true, policy: 'auto', tools: BUILTIN_TOOLS.map((name) => ({ name, enabled: null, policy: null })) }
}

function emptyForm(): AgentForm {
  return { name: '', model: '', effort: null, description: '', builtinTools: defaultTools(), mcpServers: [] }
}

// --- État éphémère ---

/** Où en est l'écriture d'un formulaire. Absent : au repos. `busy` : un envoi est en route. */
export type Flow =
  | { step: 'preparing' }
  | { step: 'creating' }
  | { step: 'review'; prepared: PreparedWrite; busy: boolean; error: string | null }
  | { step: 'conflict'; prepared: PreparedWrite; busy: boolean; message: string }
  | { step: 'applied'; label: string }
  | { step: 'notice'; tone: 'warning' | 'danger'; title: string; message: string }

/** Le flux d'écriture, par clé de formulaire. */
const flows = atom<Record<string, Flow>>({})
/** Le formulaire d'ajout d'un serveur MCP : fermé par défaut. */
const addOpen = atom(false)
type ServerDraft = { name: string; url: string; policy: ToolPolicy }
const NEW_SERVER: ServerDraft = { name: '', url: '', policy: 'always_ask' }
const serverDraft = atom<ServerDraft>(NEW_SERVER)
/** Champs du formulaire d'ajout que la personne a modifiés : leur erreur peut alors s'afficher. */
const serverTouched = atom<{ name: boolean; url: boolean }>({ name: false, url: false })
/** La section des réglages par outil : fermée par défaut. */
const perToolOpen = atom(false)

function setFlow(key: string, flow: Flow | null): void {
  update(flows, (current) => {
    const next = { ...current }
    if (flow === null) delete next[key]
    else next[key] = flow
    return next
  })
}

/** Vrai quand un envoi est en route. */
function isBusy(flow: Flow | undefined): boolean {
  return flow?.step === 'preparing' || flow?.step === 'creating' || ((flow?.step === 'review' || flow?.step === 'conflict') && flow.busy)
}

/** Vrai tant que la préparation, la revue ou le conflit tiennent le formulaire : ses champs sont grisés. */
function isLocked(flow: Flow | undefined): boolean {
  return flow?.step === 'preparing' || flow?.step === 'creating' || flow?.step === 'review' || flow?.step === 'conflict'
}

function resetAddServer(): void {
  set(addOpen, false)
  set(serverDraft, NEW_SERVER)
  set(serverTouched, { name: false, url: false })
}

/** Les flux qui survivent à la sortie d'un écran : tout sauf un résultat déjà lu ou un avis. */
export function withoutTransientFlows(current: Record<string, Flow>): Record<string, Flow> {
  return Object.fromEntries(Object.entries(current).filter(([, flow]) => flow.step !== 'applied' && flow.step !== 'notice'))
}

/**
 * À la sortie d'un écran d'agent : le résultat d'une écriture, un avis et le formulaire d'ajout ne survivent pas.
 * Un envoi en vol (« Creating… », revue occupée) reste : Create demeure grisé au retour jusqu'à l'atterrissage du
 * premier envoi, sans quoi un second `write.commit` créerait l'agent en double.
 */
export function leaveAgentView(): void {
  update(flows, withoutTransientFlows)
  resetAddServer()
}

/** Oublie la saisie gardée de ce formulaire, et le résultat ou l'avis affiché. */
function discardForm(key: string): void {
  clearForm(key)
  setFlow(key, null)
}

// --- Actions ---

type Target = { key: string; id: string | null; base: AgentForm; version: number | null }

function noticeOf(failure: { code: ApiErrorCode; error: string }, warningTitle: string, dangerTitle: string): Flow {
  const warning = WARNING_CODES.includes(failure.code)
  return { step: 'notice', tone: warning ? 'warning' : 'danger', title: warning ? warningTitle : dangerTitle, message: clipBytes(failure.error, ERROR_TEXT_LIMIT_BYTES).text }
}

async function showFailure(key: string, failure: { code: ApiErrorCode; error: string }, warningTitle: string, dangerTitle: string): Promise<void> {
  if (failure.code === 'unauthorized') {
    setFlow(key, null)
    await loadWorkspace()
    return
  }
  setFlow(key, noticeOf(failure, warningTitle, dangerTitle))
}

/**
 * « Review changes » : met l'écriture en attente. La base et la version envoyées sont celles de la saisie gardée (la
 * version sur laquelle elle a été commencée), jamais celles du détail frais. Une création n'a rien à comparer : elle
 * part aussitôt après sa préparation, sans écran de revue (le bouton `Create` dit qu'il travaille).
 */
async function prepare(target: Target): Promise<void> {
  const { key, id } = target
  if (isBusy(read(flows)[key])) return
  const { form, base, baseStamp } = readForm(key, target.base, target.version)
  setFlow(key, { step: id === null ? 'creating' : 'preparing' })
  let result
  try {
    result = await plugin.request('agent.prepareForm', {
      agentId: id,
      baseVersion: typeof baseStamp === 'number' ? baseStamp : null,
      form,
      base: id === null ? null : base
    })
  } catch (error) {
    setFlow(key, null)
    throw error
  }
  if (!result.ok) {
    await showFailure(key, result, 'Not applied', 'Could not prepare the changes')
    return
  }
  if (id !== null) {
    setFlow(key, { step: 'review', prepared: result.value, busy: false, error: null })
    return
  }
  let created
  try {
    created = await plugin.request('write.commit', { token: result.value.token, force: false })
  } catch (error) {
    setFlow(key, null)
    throw error
  }
  if (created.ok) await finishWrite(target, created.value)
  else await showFailure(key, created, 'Not created', 'Could not create the agent')
}

/** « Confirm » (ou « Apply anyway » après un conflit) : envoie l'écriture en attente. */
async function commit(target: Target, force: boolean): Promise<void> {
  const { key } = target
  const flow = read(flows)[key]
  if ((flow?.step !== 'review' && flow?.step !== 'conflict') || flow.busy) return
  const { prepared } = flow
  setFlow(key, { ...flow, busy: true })
  let result
  try {
    result = await plugin.request('write.commit', { token: prepared.token, force })
  } catch (error) {
    setFlow(key, { ...flow, busy: false })
    throw error
  }
  if (result.ok) {
    await finishWrite(target, result.value)
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

/** Après l'écriture : la relecture (`readBack`), dont un échec s'affiche sur le formulaire au lieu de le laisser occupé. */
async function finishWrite(target: Target, committed: Committed): Promise<void> {
  try {
    await readBack(target, committed)
  } catch (error) {
    // L'écriture a réussi : une relecture qui échoue ne laisse pas le formulaire en « Creating… » ou en revue occupée.
    const { key, id } = target
    const message = clipBytes(error instanceof Error ? error.message : String(error), ERROR_TEXT_LIMIT_BYTES).text
    // La saisie d'une création ne doit pas pouvoir recréer l'agent qui existe déjà.
    if (id === null) clearForm(key)
    // Un détail jamais revenu laisserait « Loading details » pour toujours : l'erreur prend sa place, avec Retry.
    if (id !== null && read(configDetail) === null) set(configDetailError, message)
    setFlow(key, { step: 'notice', tone: 'danger', title: clipTitle(`${committed.label}, but it could not be read back`), message })
  }
}

/**
 * La liste est relue, puis le détail (ou, pour une création, le détail du nouvel agent). La saisie gardée disparaît
 * une fois le détail vidé (l'écran passe par « Loading details »), jamais avant : sinon l'ancienne base reparaîtrait un instant.
 */
async function readBack(target: Target, committed: Committed): Promise<void> {
  const { key, id } = target
  if (id !== null) {
    const reloading = loadDetail('agent', id)
    clearForm(key)
    setFlow(key, { step: 'applied', label: committed.label })
    await Promise.all([loadConfigs('agent'), reloading])
    return
  }
  await loadConfigs('agent')
  if (committed.id === undefined) {
    clearForm(key)
    setFlow(key, { step: 'applied', label: committed.label })
    return
  }
  // Le résultat suit sur le détail du nouvel agent ; le formulaire de création, s'il est encore ouvert, lui cède la place.
  setFlow(formKey('agent', committed.id), { step: 'applied', label: committed.label })
  if (popIfTop((entry) => entry.view === 'newConfig' && entry.kind === 'agent')) openConfig('agent', committed.id)
  clearForm(key)
  setFlow(key, null)
}

/** « Reload » d'un conflit : relit l'agent et abandonne la saisie gardée. */
async function reload(key: string, id: string): Promise<void> {
  discardForm(key)
  await loadDetail('agent', id)
}

/** Archive l'agent, revient à l'accueil et relit la liste. Un refus de l'API remonte à `ConfirmPanel`. */
async function removeAgent(key: string, id: string): Promise<void> {
  const result = await plugin.request('resource.archive', { kind: 'agent', id })
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'agent' && entry.id === id)
  await loadConfigs('agent')
}

/** Un agent créé depuis son YAML : la liste est relue, puis son détail s'ouvre à la place du formulaire de création. */
function openCreatedAgent(committed: Committed): void {
  run(async () => {
    await loadConfigs('agent')
    if (committed.id === undefined) return
    carryDraftOutcome(agentDraft(null), agentDraft(committed.id))
    if (popIfTop((entry) => entry.view === 'newConfig' && entry.kind === 'agent')) openConfig('agent', committed.id)
  })
}

function goBack(): void {
  leaveAgentView()
  update(nav, popView)
}

// --- Rendu : champs ---

function serverProblems(draft: ServerDraft, servers: AgentForm['mcpServers']): { name: string | null; url: string | null } {
  const name = draft.name.trim()
  const url = draft.url.trim()
  return {
    name: name === '' ? 'Name is required.' : servers.some((server) => server.name === name) ? 'A server with this name already exists.' : null,
    url: url === '' ? 'URL is required.' : /^https?:\/\/[^\s/]+\S*$/i.test(url) ? null : 'Use an http or https URL.'
  }
}

function ModelField({ form, models, disabled, onChange }: { form: AgentForm; models: string[] | null; disabled: boolean; onChange: (model: string) => void }) {
  // Sans liste de l'API, un champ libre : le modèle reste modifiable.
  if (models === null || models.length === 0) {
    return <Input label="Model" disabled={disabled} value={form.model} onChange={onChange} />
  }
  const options = form.model === '' || models.includes(form.model) ? models : [form.model, ...models]
  return (
    <Select
      label="Model"
      placeholder="Choose a model"
      disabled={disabled}
      value={form.model === '' ? undefined : form.model}
      options={options.map((value) => ({ value, label: clipTitle(value) }))}
      onChange={onChange}
    />
  )
}

/** Les réglages d'un outil intégré : deux listes sur une ligne qui passe à la ligne quand la place manque. */
function ToolRow({ tool, disabled, onChange }: { tool: AgentToolsForm['tools'][number]; disabled: boolean; onChange: (changes: Partial<Omit<typeof tool, 'name'>>) => void }) {
  return (
    <Stack gap="xs">
      <Text size="sm" weight="medium">
        {tool.name}
      </Text>
      <Box direction="row" wrap gap="sm">
        <Box grow minWidth={FIELD_MIN_WIDTH}>
          <Select
            label={`${tool.name} state`}
            labelHidden
            disabled={disabled}
            value={tool.enabled === null ? DEFAULT_CHOICE : tool.enabled ? 'enabled' : 'disabled'}
            options={ENABLED_OPTIONS}
            onChange={(value) => onChange({ enabled: value === 'enabled' ? true : value === 'disabled' ? false : null })}
          />
        </Box>
        <Box grow minWidth={FIELD_MIN_WIDTH}>
          <Select
            label={`${tool.name} permission`}
            labelHidden
            disabled={disabled}
            value={tool.policy ?? DEFAULT_CHOICE}
            options={TOOL_POLICY_OPTIONS}
            onChange={(value) => onChange({ policy: asPolicy(value) })}
          />
        </Box>
      </Box>
    </Stack>
  )
}

function customisedSummary(tools: AgentToolsForm): string {
  const count = tools.tools.filter((tool) => tool.enabled !== null || tool.policy !== null).length
  return count === 0 ? 'All tools use the defaults' : `${count} tool${count === 1 ? '' : 's'} customised`
}

type ServersProps = {
  servers: AgentForm['mcpServers']
  disabled: boolean
  onPolicy: (name: string, policy: ToolPolicy) => void
  onRemove: (name: string) => void
  onAdd: (server: ServerDraft) => void
}

/** Les serveurs MCP : un groupe de lignes (nom, URL, politique, Remove), puis « Add MCP server » et son formulaire fermé par défaut. */
function ServersZone({ servers, disabled, onPolicy, onRemove, onAdd }: ServersProps) {
  const draft = read(serverDraft)
  const touched = read(serverTouched)
  const problems = serverProblems(draft, servers)
  const edit = (changes: Partial<ServerDraft>): void => update(serverDraft, (current) => ({ ...current, ...changes }))
  return (
    <Stack gap="sm">
      <GroupCard
        title="MCP servers"
        rows={
          servers.length === 0
            ? [<EmptyView kind="list" text="No MCP servers." />]
            : servers.slice(0, MAX_RENDERED_SERVERS).map((server) => ({
                key: server.name,
                row: (
                  // Une unité, deux lignes à toute largeur : le nom et l'URL, puis la politique (qui prend la place libre) et le Remove collé à la fin.
                  <Stack gap="none">
                    <ItemRow lead={{ kind: 'monogram', text: server.name }} title={clipTitle(server.name)} subtitle={clipBytes(server.url, DESCRIPTION_LIMIT_BYTES).text} />
                    <Box paddingY="xs">
                      <Row gap="sm" align="center">
                        <Box grow minWidth={0}>
                          <Select
                            label={`Policy of ${clipTitle(server.name)}`}
                            labelHidden
                            disabled={disabled}
                            value={server.policy}
                            options={POLICY_OPTIONS}
                            onChange={(value) => {
                              const policy = asPolicy(value)
                              if (policy !== null) onPolicy(server.name, policy)
                            }}
                          />
                        </Box>
                        <Box shrink={false}>
                          <IconButton icon="delete" label={`Remove ${clipTitle(server.name)}`} variant="ghost" size="sm" disabled={disabled} onPress={() => onRemove(server.name)} />
                        </Box>
                      </Row>
                    </Box>
                  </Stack>
                )
              }))
        }
      />
      {read(addOpen) ? (
        <Box border radius="md" padding="sm">
          <Stack gap="sm">
            <Input
              label="Name"
              disabled={disabled}
              value={draft.name}
              invalid={touched.name && problems.name !== null}
              onChange={(value) => {
                update(serverTouched, (current) => ({ ...current, name: true }))
                edit({ name: value })
              }}
            />
            {touched.name && problems.name !== null ? (
              <Text tone="danger" size="xs">
                {problems.name}
              </Text>
            ) : null}
            <Input
              label="URL"
              disabled={disabled}
              placeholder="https://"
              value={draft.url}
              invalid={touched.url && problems.url !== null}
              onChange={(value) => {
                update(serverTouched, (current) => ({ ...current, url: true }))
                edit({ url: value })
              }}
            />
            {touched.url && problems.url !== null ? (
              <Text tone="danger" size="xs">
                {problems.url}
              </Text>
            ) : null}
            <Select
              label="Policy"
              disabled={disabled}
              value={draft.policy}
              options={POLICY_OPTIONS}
              onChange={(value) => edit({ policy: asPolicy(value) ?? 'always_ask' })}
            />
            <Row gap="sm" wrap>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || problems.name !== null || problems.url !== null}
                onPress={() => {
                  onAdd({ ...draft, name: draft.name.trim(), url: draft.url.trim() })
                  resetAddServer()
                }}
              >
                Add
              </Button>
              <Button variant="ghost" size="sm" onPress={resetAddServer}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Box>
      ) : (
        <Row>
          <Button variant="outline" size="sm" icon="add" disabled={disabled} onPress={() => set(addOpen, true)}>
            Add MCP server
          </Button>
        </Row>
      )}
    </Stack>
  )
}

// --- Rendu : résultat d'une écriture ---

function FlowView({ target, flow }: { target: Target; flow: Flow }): OrcaNode {
  const { key, id } = target
  switch (flow.step) {
    case 'preparing':
      return <Spinner label="Preparing changes" />
    case 'creating':
      return null
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
            onConfirm={() => run(() => commit(target, false))}
            onCancel={() => setFlow(key, null)}
          />
        </Stack>
      )
    case 'conflict':
      return (
        <Callout tone="warning" title={flow.message}>
          <Stack gap="sm">
            <Text size="sm">Reload drops your changes. Apply anyway overwrites what changed.</Text>
            <Row gap="sm" wrap>
              <Button variant="outline" size="sm" disabled={flow.busy || id === null} onPress={() => (id === null ? undefined : run(() => reload(key, id)))}>
                Reload
              </Button>
              <Button variant="solid" size="sm" disabled={flow.busy} onPress={() => run(() => commit(target, true))}>
                Apply anyway
              </Button>
            </Row>
          </Stack>
        </Callout>
      )
    case 'applied':
      return <Callout tone="success" title={clipTitle(flow.label)} />
    case 'notice':
      return (
        <Callout tone={flow.tone} title={flow.title}>
          <Text size="sm">{flow.message}</Text>
        </Callout>
      )
  }
}

// --- Rendu : lecture seule ---

/** Le prompt, les skills, `multiagent` et les réglages par outil MCP : lus ici, écrits dans le YAML. */
function YamlZone({ agent }: { agent: AgentDetail }) {
  const ref = agentDraft(agent.id)
  const reread = (): void => run(async () => {
    await loadConfigs('agent')
    await loadDetail('agent', agent.id)
  })
  const overridden = agent.mcpServers.filter((server) => server.overrides.length > 0).slice(0, MAX_RENDERED_SERVERS)
  return (
    <Stack gap="sm">
      <Text weight="semibold">Edited in YAML</Text>
      <Stack gap="xs">
        {agent.system.text ? (
          <CodeView code={agent.system.text} label="System prompt" wrap maxHeight="md" />
        ) : (
          <Text muted size="sm">
            No system prompt.
          </Text>
        )}
        {agent.system.truncated ? (
          <Text muted size="xs">
            {TRUNCATED_NOTICE}
          </Text>
        ) : null}
      </Stack>
      {agent.skills.length > 0 ? <Text size="sm">{`Skills: ${clipBytes(agent.skills.join(', '), LONG_TEXT_LIMIT_BYTES).text}`}</Text> : null}
      {agent.multiagent ? <Text size="sm">{clipBytes(agent.multiagent, LONG_TEXT_LIMIT_BYTES).text}</Text> : null}
      {overridden.map((server) => (
        <Stack key={server.name} gap="xs">
          <Text muted size="xs">
            {`${clipTitle(server.name)} tool settings`}
          </Text>
          <KeyValue
            label={`${clipTitle(server.name)} tool settings`}
            items={server.overrides.slice(0, MAX_RENDERED_SERVERS).map((tool) => ({
              label: clipTitle(tool.name),
              value: `${tool.enabled ? 'enabled' : 'disabled'}${tool.policy ? `, ${POLICY_LABELS[tool.policy]}` : ''}`
            }))}
          />
        </Stack>
      ))}
      <Row>
        <Button variant="outline" size="sm" disabled={draftIsBusy(ref)} onPress={() => startDraft(ref)}>
          Edit in YAML
        </Button>
      </Row>
      {/* Un seul bloc de contrôles par écran : plusieurs du même brouillon dupliqueraient l'aperçu et la carte d'installation. */}
      <DraftControls draftRef={ref} label="Edit in YAML" showOpen={false} onApplied={reread} />
    </Stack>
  )
}

/** Les autres façons de créer un agent : son YAML, ou (plus tard) Claude. */
function StartElsewhere() {
  return (
    <Stack gap="sm">
      <Text weight="semibold">Other ways to start</Text>
      <DraftControls draftRef={agentDraft(null)} label="New agent from YAML" onApplied={openCreatedAgent} />
      <Stack gap="xs">
        <Row>
          <Button variant="outline" size="sm" disabled onPress={() => undefined}>
            Generate with Claude
          </Button>
        </Row>
        <Text muted size="xs">
          Coming in a later version
        </Text>
      </Stack>
    </Stack>
  )
}

// --- Rendu : formulaire ---

type BodyProps = { id: string | null; base: AgentForm; version: number | null; name: string; agent: AgentDetail | null }

function AgentFormBody({ id, base, version, name, agent }: BodyProps) {
  const key = formKey('agent', id)
  const { form, base: draftBase, baseStamp, dirty, stale } = readForm(key, base, version)
  const latest = (): AgentForm => readForm(key, base, version).form
  const change = (changes: Partial<AgentForm>): void => {
    // Un résultat ou un avis déjà lu ne vaut plus une fois la saisie reprise.
    const flow = read(flows)[key]
    if (flow?.step === 'applied' || flow?.step === 'notice') setFlow(key, null)
    editForm(key, { ...latest(), ...changes }, base, version)
  }
  const changeTools = (changes: Partial<AgentToolsForm>): void => {
    const tools = latest().builtinTools
    if (tools !== null) change({ builtinTools: { ...tools, ...changes } })
  }
  const target: Target = { key, id, base, version }
  const flow = read(flows)[key]
  const locked = isLocked(flow)
  const tools = form.builtinTools
  const nameMissing = form.name.trim() === ''
  const problem = nameMissing || form.model.trim() === ''
  // L'erreur du nom attend que la personne l'ait modifié une fois : un formulaire neuf ne s'ouvre pas en rouge.
  const nameInvalid = nameMissing && isTouched(key, 'name')
  // Le pied (le bouton principal) reste là au repos et pendant une création ; la revue ou le conflit le remplacent.
  const showFooter = flow === undefined || flow.step === 'applied' || flow.step === 'notice' || flow.step === 'creating'
  const creating = flow?.step === 'creating'
  return (
    <Stack gap="lg">
      {stale && id !== null ? (
        <Callout tone="warning" title={CONFLICT_TITLE}>
          <Stack gap="sm">
            <Text size="sm">
              {dirty
                ? `Started on v${String(baseStamp)}, the agent is now v${String(version)}. Your changes are kept; Reload or Discard drops them.`
                : `Started on v${String(baseStamp)}, the agent is now v${String(version)}. Reload reads the current version.`}
            </Text>
            <Row>
              <Button variant="outline" size="sm" disabled={locked} onPress={() => run(() => reload(key, id))}>
                Reload
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {id !== null ? (
        <Text muted size="xs">
          {`Version ${String(version)}`}
        </Text>
      ) : null}
      <Stack gap="sm">
        <Input
          label="Name"
          disabled={locked}
          value={form.name}
          invalid={nameInvalid}
          onChange={(value) => {
            touchField(key, 'name')
            change({ name: value })
          }}
        />
        <Textarea label="Description" placeholder="Optional" rows={2} disabled={locked} value={form.description} onChange={(value) => change({ description: value })} />
        <Box direction="row" wrap gap="sm">
          <Box grow minWidth={FIELD_MIN_WIDTH}>
            <ModelField form={form} models={read(agentModels)} disabled={locked} onChange={(model) => change({ model })} />
          </Box>
          <Box grow minWidth={FIELD_MIN_WIDTH}>
            <Select
              label="Effort"
              disabled={locked}
              value={form.effort ?? (id === null ? DEFAULT_CHOICE : undefined)}
              options={id === null ? NEW_EFFORT_OPTIONS : EFFORT_OPTIONS}
              onChange={(value) => change({ effort: asEffort(value) })}
            />
          </Box>
        </Box>
      </Stack>
      <GroupCard
        title="Built-in tools"
        rows={[
          // Chaque ligne respire de part et d'autre du filet, comme celles des serveurs MCP.
          <Box paddingY="xs">
            <Switch
              label="Enabled"
              disabled={locked}
              checked={tools?.enabled ?? false}
              onChange={(checked) => {
                const current = latest().builtinTools
                if (checked) change({ builtinTools: current === null ? defaultTools() : { ...current, enabled: true } })
                // Un agent sans toolset qui l'a activé puis désactivé revient à sans toolset ; sinon le toolset reste, désactivé.
                else change({ builtinTools: current === null || draftBase.builtinTools === null ? null : { ...current, enabled: false } })
              }}
            />
          </Box>,
          tools !== null ? (
            <Box paddingY="xs">
              <Stack gap="sm">
                <Select
                  label="Default permission"
                  disabled={locked}
                  value={tools.policy}
                  options={POLICY_OPTIONS}
                  onChange={(value) => {
                    const policy = asPolicy(value)
                    if (policy !== null) changeTools({ policy })
                  }}
                />
                <SectionCollapsible title="Per-tool settings" summary={customisedSummary(tools)} open={read(perToolOpen)} onChange={(next) => set(perToolOpen, next)}>
                  <Stack gap="md">
                    {tools.tools.map((tool) => (
                      <ToolRow
                        key={tool.name}
                        tool={tool}
                        disabled={locked}
                        onChange={(changes) => changeTools({ tools: tools.tools.map((entry) => (entry.name === tool.name ? { ...entry, ...changes } : entry)) })}
                      />
                    ))}
                  </Stack>
                </SectionCollapsible>
              </Stack>
            </Box>
          ) : null
        ]}
      />
      <ServersZone
        servers={form.mcpServers}
        disabled={locked}
        onPolicy={(serverName, policy) => change({ mcpServers: latest().mcpServers.map((server) => (server.name === serverName ? { ...server, policy } : server)) })}
        onRemove={(serverName) => change({ mcpServers: latest().mcpServers.filter((server) => server.name !== serverName) })}
        onAdd={(server) => change({ mcpServers: [...latest().mcpServers, server] })}
      />
      <Stack gap="sm">
        {flow !== undefined ? <FlowView target={target} flow={flow} /> : null}
        {showFooter ? (
          <Stack gap="xs">
            {dirty ? (
              <Text muted size="xs">
                Unsaved changes
              </Text>
            ) : null}
            <Row gap="sm" align="center" wrap>
              <Button variant="solid" tone="accent" disabled={creating || problem || (id !== null && !dirty)} onPress={() => run(() => prepare(target))}>
                {id === null ? (creating ? 'Creating…' : 'Create') : 'Review changes'}
              </Button>
              {dirty ? (
                <Button variant="ghost" disabled={creating} onPress={() => discardForm(key)}>
                  Discard
                </Button>
              ) : null}
            </Row>
            {problem ? (
              <Text muted size="xs">
                Name and model are required.
              </Text>
            ) : null}
          </Stack>
        ) : null}
      </Stack>
      <Separator />
      {agent !== null ? <YamlZone agent={agent} /> : <StartElsewhere />}
      {agent !== null ? (
        <Stack gap="sm">
          <Separator />
          <Row>
            <Button variant="ghost" tone="danger" size="sm" disabled={locked} onPress={() => askConfirmation(`agent:${agent.id}:archive`)}>
              Archive
            </Button>
          </Row>
          <ConfirmPanel
            actionKey={`agent:${agent.id}:archive`}
            question={archiveQuestion(name)}
            confirmLabel="Archive"
            disabled={locked}
            onConfirm={() => removeAgent(key, agent.id)}
          />
        </Stack>
      ) : null}
    </Stack>
  )
}

/** `id` null : la création ; sinon l'agent chargé dans le détail ouvert. */
export function AgentFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <Row gap="sm" align="center" justify="between" wrap>
          <Button variant="ghost" size="sm" onPress={goBack}>
            ‹ Back
          </Button>
        </Row>
        <Text weight="semibold">New agent</Text>
        <AgentFormBody id={null} base={emptyForm()} version={null} name="" agent={null} />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'agent' || detail.id !== id) return <Spinner label="Loading details" />
  return <AgentFormBody id={id} base={detail.form} version={detail.version} name={clipTitle(detail.name)} agent={detail} />
}
