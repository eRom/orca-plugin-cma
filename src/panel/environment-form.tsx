// Formulaire d'un environnement : création, modification, archivage et suppression. La saisie en cours
// est gardée par `form-state` (atome persisté) ; le texte brut des champs multi-lignes y reste aussi, en
// éphémère, pour ne pas réécrire ce que la personne tape (`a` ne devient pas `a=` pendant la frappe).
import {
  atom,
  Box,
  Button,
  Callout,
  Checkbox,
  Input,
  plugin,
  RadioGroup,
  read,
  Row,
  set,
  Stack,
  Text,
  Textarea,
  update,
  type OrcaNode
} from 'orca'
import {
  PACKAGE_MANAGERS,
  type ApiResult,
  type ConfigKind,
  type EnvironmentForm,
  type EnvironmentNetworkForm,
  type KeyValueItem,
  type PackageManager
} from '../protocol'
import { ActionRow } from '../blocks/action-row'
import { BackHeader } from '../blocks/back-header'
import { FormSection } from '../blocks/form-section'
import { GroupCard } from '../blocks/group-card'
import { LoadingState } from '../blocks/loading-state'
import { SectionCollapsible } from '../blocks/section-collapsible'
import { metadataTextProblem, validateEnvironmentForm } from '../shared/environment-rules'
import { clipBytes } from '../shared/text'
import { archiveQuestion, askConfirmation, ConfirmPanel, deleteQuestion } from './confirm'
import { configDetail, loadConfigs, loadDetail, openConfig } from './config-state'
import {
  clearForm,
  dropFieldText,
  editForm,
  fieldText,
  formConflict,
  formKey,
  isTouched,
  readForm,
  setFieldText,
  touchField
} from './form-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popIfTop, popView, pushView, run } from './state'

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafond d'un nom repris dans un titre : un libellé de plus de 1 Kio fait refuser le rendu. */
const NAME_LIMIT_BYTES = 200

type LimitedNetwork = Extract<EnvironmentNetworkForm, { mode: 'limited' }>

const DEFAULT_LIMITED: LimitedNetwork = { mode: 'limited', allowedHosts: [], allowPackageManagers: false, allowMcpServers: false }

function emptyForm(): EnvironmentForm {
  return {
    name: '',
    description: '',
    hosting: 'cloud',
    network: { mode: 'unrestricted' },
    packages: { apt: [], cargo: [], gem: [], go: [], npm: [], pip: [] },
    metadata: []
  }
}

// --- État éphémère ---

/** Vrai pendant un enregistrement : un double appui ne part pas deux fois. */
const saving = atom(false)
/** Refus de l'enregistrement (hors conflit), avec le formulaire concerné. */
const saveFailure = atom<{ key: string; message: string } | null>(null)

/** Oublie la saisie gardée, le texte brut, le conflit et le refus de ce formulaire. */
function discardForm(key: string): void {
  clearForm(key)
  if (read(saveFailure)?.key === key) set(saveFailure, null)
}

// --- Texte ↔ formulaire ---

/** Une valeur par ligne, coupée ; les lignes vides sont ignorées. */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * `key=value` par ligne, coupé au premier `=`. Une ligne sans `=` ou à clé vide n'entre pas dans le
 * formulaire (l'API lirait une valeur vide comme une suppression) : `metadataTextProblem` la signale.
 */
function parseMetadata(text: string): KeyValueItem[] {
  const items: KeyValueItem[] = []
  for (const line of parseLines(text)) {
    const at = line.indexOf('=')
    const key = at === -1 ? '' : line.slice(0, at).trim()
    if (key !== '') items.push({ key, value: line.slice(at + 1).trim() })
  }
  return items
}

function metadataText(items: readonly KeyValueItem[]): string {
  return items.map((item) => `${item.key}=${item.value}`).join('\n')
}

function hasPackages(form: EnvironmentForm): boolean {
  return PACKAGE_MANAGERS.some((manager) => form.packages[manager].length > 0)
}

// --- Actions ---

/** Ouvre le formulaire de création d'un type de configuration. */
export function openNewConfig(kind: ConfigKind): void {
  update(nav, (stack) => pushView(stack, { view: 'newConfig', kind }))
}

/** La base et l'horodatage frais, ceux de l'objet chargé : une saisie gardée apporte les siens. */
type SaveTarget = { key: string; id: string | null; base: EnvironmentForm; baseUpdatedAt: string | null }

/** Envoie le formulaire. Un conflit ouvre son avis ; un refus s'affiche ; la réussite relit la liste puis le détail. */
async function saveForm(target: SaveTarget, force: boolean): Promise<void> {
  if (read(saving)) return
  const { key, id } = target
  // La base et l'horodatage envoyés sont ceux de la saisie gardée, forcée ou non : le worker voit ainsi un
  // changement fait ailleurs depuis, et n'envoie que les champs que la personne a touchés.
  const { form, base, baseStamp } = readForm(key, target.base, target.baseUpdatedAt)
  set(saving, true)
  set(saveFailure, null)
  try {
    const result = await plugin.request('environment.save', {
      id,
      // L'horodatage d'un environnement est une chaîne ; seul un agent aura un numéro de version.
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
    await loadConfigs('environment')
    discardForm(key)
    if (id === null) {
      // Le détail du nouvel environnement remplace le formulaire de création, s'il est encore ouvert (sinon : Back pressé).
      if (popIfTop((entry) => entry.view === 'newConfig' && entry.kind === 'environment')) {
        openConfig('environment', result.value.id)
      }
    } else {
      await loadDetail('environment', id)
    }
  } finally {
    set(saving, false)
  }
}

/** Relit l'objet vivant et abandonne la saisie gardée. */
async function reloadForm(key: string, id: string): Promise<void> {
  discardForm(key)
  await loadDetail('environment', id)
}

/** Archive ou supprime, puis revient à l'accueil et relit la liste. Un refus de l'API remonte à `ConfirmAction`. */
async function removeEnvironment(key: string, id: string, call: () => Promise<ApiResult<null>>): Promise<void> {
  const result = await call()
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'environment' && entry.id === id)
  await loadConfigs('environment')
}

function goBack(): void {
  update(nav, popView)
}

// --- Rendu ---

/** Ouverture de « Packages » choisie par la personne, par formulaire ; sans choix : ouvert seulement si l'environnement en a. */
const packagesOpen = atom<Record<string, boolean>>({})

function packagesSummary(form: EnvironmentForm): string {
  const count = PACKAGE_MANAGERS.reduce((total, manager) => total + form.packages[manager].length, 0)
  return count === 0 ? 'No packages' : `${count} package${count === 1 ? '' : 's'}`
}

type BodyProps = { id: string | null; base: EnvironmentForm; baseUpdatedAt: string | null }

/** Name, Description, l'hébergement, la carte du réseau, les paquets repliés et les métadonnées, sous leur Save. */
function EnvironmentFormBody({ id, base, baseUpdatedAt }: BodyProps) {
  const key = formKey('environment', id)
  const { form, base: draftBase, dirty, stale } = readForm(key, base, baseUpdatedAt)
  const latest = (): EnvironmentForm => readForm(key, base, baseUpdatedAt).form
  const change = (changes: Partial<EnvironmentForm>): void => editForm(key, { ...latest(), ...changes }, base, baseUpdatedAt)
  const changeLimited = (changes: Partial<LimitedNetwork>): void => {
    const { network } = latest()
    if (network.mode === 'limited') change({ network: { ...network, ...changes } })
  }
  const target: SaveTarget = { key, id, base, baseUpdatedAt }
  // Conflit annoncé par le worker, ou saisie gardée commencée sur une autre version que celle chargée.
  const conflict = read(formConflict)[key] === true || stale
  const busy = read(saving)
  const failed = read(saveFailure)
  const metadataRaw = fieldText(key, 'metadata', metadataText(form.metadata))
  const problem = validateEnvironmentForm(form) ?? metadataTextProblem(metadataRaw)
  const nameMissing = form.name.trim() === ''
  // L'erreur du nom attend que la personne l'ait modifié une fois : un formulaire neuf ne s'ouvre pas en rouge.
  const nameInvalid = nameMissing && isTouched(key, 'name')
  const network = form.network
  return (
    <FormSection
      title={id === null ? undefined : 'Details'}
      saveLabel={id === null ? 'Create' : 'Save'}
      // `busy` grise Save : il dit aussi « rien à enregistrer » (saisie intacte) et « saisie invalide ».
      busy={busy || problem !== null || (id !== null && !dirty)}
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
                <Button variant="solid" size="sm" disabled={busy || problem !== null} onPress={() => run(() => saveForm(target, true))}>
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
        id === null ? (
          <RadioGroup
            key="hosting"
            label="Hosting"
            orientation="horizontal"
            disabled={busy}
            value={form.hosting}
            options={[
              { value: 'cloud', label: 'Cloud' },
              { value: 'self_hosted', label: 'Self-hosted' }
            ]}
            onChange={(value) => change({ hosting: value === 'self_hosted' ? 'self_hosted' : 'cloud' })}
          />
        ) : (
          // L'hébergement se fixe à la création.
          <Text key="hosting" muted size="sm">{`Hosting: ${base.hosting === 'cloud' ? 'Cloud' : 'Self-hosted'}`}</Text>
        ),
        form.hosting === 'cloud' ? (
          <GroupCard
            key="network"
            title="Network"
            rows={[
              <Box paddingY="xs">
                <RadioGroup
                  label="Network"
                  labelHidden
                  orientation="horizontal"
                  disabled={busy}
                  value={network.mode}
                  options={[
                    { value: 'unrestricted', label: 'Unrestricted' },
                    { value: 'limited', label: 'Limited' }
                  ]}
                  onChange={(mode) => {
                    dropFieldText(key, 'hosts')
                    // Revenir à `Limited` retrouve les réglages du chargement, s'il y en avait.
                    change({ network: mode === 'limited' ? (draftBase.network.mode === 'limited' ? draftBase.network : DEFAULT_LIMITED) : { mode: 'unrestricted' } })
                  }}
                />
              </Box>,
              network.mode === 'limited' ? (
                <Box paddingY="xs">
                  <Stack gap="sm">
                    <Textarea
                      label="Allowed hosts"
                      placeholder="One host per line"
                      disabled={busy}
                      rows={4}
                      value={fieldText(key, 'hosts', network.allowedHosts.join('\n'))}
                      onChange={(text) => {
                        setFieldText(key, 'hosts', text)
                        changeLimited({ allowedHosts: parseLines(text) })
                      }}
                    />
                    <Checkbox
                      label="Allow package managers"
                      disabled={busy}
                      checked={network.allowPackageManagers}
                      onChange={(checked) => changeLimited({ allowPackageManagers: checked })}
                    />
                    <Checkbox label="Allow MCP servers" disabled={busy} checked={network.allowMcpServers} onChange={(checked) => changeLimited({ allowMcpServers: checked })} />
                  </Stack>
                </Box>
              ) : null
            ]}
          />
        ) : (
          <Text key="network" muted size="sm">
            Network and packages are managed by the host.
          </Text>
        ),
        form.hosting === 'cloud' ? (
          <SectionCollapsible
            key="packages"
            title="Packages"
            summary={packagesSummary(form)}
            open={read(packagesOpen)[key] ?? hasPackages(form)}
            onChange={(next) => update(packagesOpen, (current) => ({ ...current, [key]: next }))}
          >
            <Stack gap="sm">
              {PACKAGE_MANAGERS.map((manager: PackageManager) => (
                <Textarea
                  key={manager}
                  label={manager}
                  placeholder="One package per line"
                  disabled={busy}
                  rows={2}
                  value={fieldText(key, manager, form.packages[manager].join('\n'))}
                  onChange={(text) => {
                    setFieldText(key, manager, text)
                    change({ packages: { ...latest().packages, [manager]: parseLines(text) } })
                  }}
                />
              ))}
            </Stack>
          </SectionCollapsible>
        ) : null,
        <Textarea
          key="metadata"
          label="Metadata"
          placeholder="key=value, one per line"
          rows={3}
          disabled={busy}
          value={metadataRaw}
          onChange={(text) => {
            setFieldText(key, 'metadata', text)
            change({ metadata: parseMetadata(text) })
          }}
        />,
        problem !== null && !nameMissing ? (
          <Text key="problem" tone="danger" size="sm">
            {problem}
          </Text>
        ) : null,
        dirty ? (
          <Text key="dirty" muted size="xs">
            Unsaved changes
          </Text>
        ) : null
      ]}
    </FormSection>
  )
}

/** Archiver et supprimer l'environnement : en bas de l'écran, une rangée à part avec sa confirmation. */
function EnvironmentActions({ id, name }: { id: string; name: string }) {
  const key = formKey('environment', id)
  const busy = read(saving)
  const archiveKey = `environment:${id}:archive`
  const deleteKey = `environment:${id}:delete`
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
        onConfirm={() => removeEnvironment(key, id, () => plugin.request('resource.archive', { kind: 'environment', id }))}
      />
      <ConfirmPanel
        actionKey={deleteKey}
        question={deleteQuestion(name)}
        confirmLabel="Delete"
        disabled={busy}
        onConfirm={() => removeEnvironment(key, id, () => plugin.request('resource.delete', { kind: 'environment', id }))}
      />
    </Stack>
  )
}

/** `id` null : la création ; sinon l'environnement chargé dans le détail ouvert (son en-tête est celui de `ConfigDetailView`). */
export function EnvironmentFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <BackHeader title="New environment" onBack={goBack} />
        <EnvironmentFormBody id={null} base={emptyForm()} baseUpdatedAt={null} />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'environment' || detail.id !== id) return <LoadingState kind="operation" label="Loading details" />
  return (
    <Stack gap="lg">
      <EnvironmentFormBody id={id} base={detail.form} baseUpdatedAt={detail.updatedAt} />
      <EnvironmentActions id={id} name={clipBytes(detail.name, NAME_LIMIT_BYTES).text} />
    </Stack>
  )
}
