// Formulaire d'un environnement : création, modification, archivage et suppression. La saisie en cours
// est gardée par `form-state` (atome persisté) ; le texte brut des champs multi-lignes reste ici, en
// éphémère, pour ne pas réécrire ce que la personne tape (`a` ne devient pas `a=` pendant la frappe).
import {
  atom,
  Button,
  Callout,
  Checkbox,
  Collapsible,
  Input,
  plugin,
  RadioGroup,
  read,
  Row,
  set,
  Spinner,
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
import { validateEnvironmentForm } from '../shared/environment-rules'
import { clipBytes } from '../shared/text'
import { archiveQuestion, ConfirmAction, deleteQuestion } from './confirm'
import { configDetail, loadConfigs, loadDetail, openConfig } from './config-views'
import { clearForm, editForm, formConflict, formKey, readForm } from './form-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popView, pushView, run } from './state'

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

/** Texte brut des champs multi-lignes, par formulaire et par champ ; absent, il se déduit du formulaire. */
const rawTexts = atom<Record<string, string>>({})
/** Vrai pendant un enregistrement : un double appui ne part pas deux fois. */
const saving = atom(false)
/** Refus de l'enregistrement (hors conflit), avec le formulaire concerné. */
const saveFailure = atom<{ key: string; message: string } | null>(null)

const rawKey = (key: string, field: string): string => `${key}#${field}`

function fieldText(key: string, field: string, derived: string): string {
  return read(rawTexts)[rawKey(key, field)] ?? derived
}

function setFieldText(key: string, field: string, text: string): void {
  update(rawTexts, (texts) => ({ ...texts, [rawKey(key, field)]: text }))
}

function dropFieldText(key: string, field: string): void {
  update(rawTexts, ({ [rawKey(key, field)]: _dropped, ...rest }) => rest)
}

/** Oublie la saisie gardée, le texte brut, le conflit et le refus de ce formulaire. */
function discardForm(key: string): void {
  clearForm(key)
  update(rawTexts, (texts) => Object.fromEntries(Object.entries(texts).filter(([name]) => !name.startsWith(`${key}#`))))
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

/** `key=value` par ligne, coupé au premier `=` ; une ligne sans `=` est une clé sans valeur. */
function parseMetadata(text: string): KeyValueItem[] {
  return parseLines(text).map((line) => {
    const at = line.indexOf('=')
    return at === -1 ? { key: line, value: '' } : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
  })
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

type SaveTarget = { key: string; id: string | null; base: EnvironmentForm; baseUpdatedAt: string | null }

/** Envoie le formulaire. Un conflit ouvre son avis ; un refus s'affiche ; la réussite relit la liste puis le détail. */
async function saveForm(target: SaveTarget, force: boolean): Promise<void> {
  if (read(saving)) return
  const { key, id, base, baseUpdatedAt } = target
  const { form } = readForm(key, base)
  set(saving, true)
  set(saveFailure, null)
  try {
    const result = await plugin.request('environment.save', { id, baseUpdatedAt, force, form, base: id === null ? null : base })
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
      // Le détail du nouvel environnement remplace le formulaire de création.
      update(nav, popView)
      openConfig('environment', result.value.id)
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
async function removeEnvironment(key: string, call: () => Promise<ApiResult<null>>): Promise<void> {
  const result = await call()
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  update(nav, popView)
  await loadConfigs('environment')
}

function goBack(): void {
  update(nav, popView)
}

// --- Rendu ---

type BodyProps = { id: string | null; base: EnvironmentForm; baseUpdatedAt: string | null; name: string }

function EnvironmentFormBody({ id, base, baseUpdatedAt, name }: BodyProps) {
  const key = formKey('environment', id)
  const { form, dirty } = readForm(key, base)
  const latest = (): EnvironmentForm => readForm(key, base).form
  const change = (changes: Partial<EnvironmentForm>): void => editForm(key, { ...latest(), ...changes })
  const changeLimited = (changes: Partial<LimitedNetwork>): void => {
    const { network } = latest()
    if (network.mode === 'limited') change({ network: { ...network, ...changes } })
  }
  const target: SaveTarget = { key, id, base, baseUpdatedAt }
  const conflict = read(formConflict)[key] === true
  const busy = read(saving)
  const failed = read(saveFailure)
  const problem = validateEnvironmentForm(form)
  const nameMissing = form.name.trim() === ''
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
              <Button variant="solid" size="sm" disabled={busy || problem !== null} onPress={() => run(() => saveForm(target, true))}>
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
      <Input label="Name" value={form.name} invalid={nameMissing} onChange={(value) => change({ name: value })} />
      <Input label="Description" placeholder="Optional" value={form.description} onChange={(value) => change({ description: value })} />
      {id === null ? (
        <RadioGroup
          label="Hosting"
          value={form.hosting}
          options={[
            { value: 'cloud', label: 'Cloud' },
            { value: 'self_hosted', label: 'Self-hosted' }
          ]}
          onChange={(value) => change({ hosting: value === 'self_hosted' ? 'self_hosted' : 'cloud' })}
        />
      ) : (
        <Text size="sm">{`Hosting: ${base.hosting === 'cloud' ? 'Cloud' : 'Self-hosted'}`}</Text>
      )}
      {form.hosting === 'cloud' ? (
        <>
          <RadioGroup
            label="Network"
            value={form.network.mode}
            options={[
              { value: 'unrestricted', label: 'Unrestricted' },
              { value: 'limited', label: 'Limited' }
            ]}
            onChange={(mode) => {
              dropFieldText(key, 'hosts')
              // Revenir à `Limited` retrouve les réglages du chargement, s'il y en avait.
              change({ network: mode === 'limited' ? (base.network.mode === 'limited' ? base.network : DEFAULT_LIMITED) : { mode: 'unrestricted' } })
            }}
          />
          {form.network.mode === 'limited' ? (
            <Stack gap="sm">
              <Textarea
                label="Allowed hosts"
                placeholder="One host per line"
                rows={4}
                value={fieldText(key, 'hosts', form.network.allowedHosts.join('\n'))}
                onChange={(text) => {
                  setFieldText(key, 'hosts', text)
                  changeLimited({ allowedHosts: parseLines(text) })
                }}
              />
              <Checkbox
                label="Allow package managers"
                checked={form.network.allowPackageManagers}
                onChange={(checked) => changeLimited({ allowPackageManagers: checked })}
              />
              <Checkbox
                label="Allow MCP servers"
                checked={form.network.allowMcpServers}
                onChange={(checked) => changeLimited({ allowMcpServers: checked })}
              />
            </Stack>
          ) : null}
          <Collapsible title="Packages" defaultOpen={hasPackages(form)}>
            <Stack gap="sm">
              {PACKAGE_MANAGERS.map((manager: PackageManager) => (
                <Textarea
                  key={manager}
                  label={manager}
                  placeholder="One package per line"
                  rows={2}
                  value={fieldText(key, manager, form.packages[manager].join('\n'))}
                  onChange={(text) => {
                    setFieldText(key, manager, text)
                    change({ packages: { ...latest().packages, [manager]: parseLines(text) } })
                  }}
                />
              ))}
            </Stack>
          </Collapsible>
        </>
      ) : (
        <Text muted size="sm">
          Network and packages are managed by the host.
        </Text>
      )}
      <Textarea
        label="Metadata"
        placeholder="key=value, one per line"
        rows={3}
        value={fieldText(key, 'metadata', metadataText(form.metadata))}
        onChange={(text) => {
          setFieldText(key, 'metadata', text)
          change({ metadata: parseMetadata(text) })
        }}
      />
      {problem !== null && !nameMissing ? (
        <Text tone="danger" size="sm">
          {problem}
        </Text>
      ) : null}
      <Row gap="sm" align="center" wrap>
        <Button disabled={busy || problem !== null || (id !== null && !dirty)} onPress={() => run(() => saveForm(target, false))}>
          {id === null ? 'Create' : 'Save'}
        </Button>
        {id !== null ? (
          <>
            <ConfirmAction
              actionKey={`environment:${id}:archive`}
              label="Archive"
              question={archiveQuestion(name)}
              confirmLabel="Archive"
              disabled={busy}
              onConfirm={() => removeEnvironment(key, () => plugin.request('resource.archive', { kind: 'environment', id }))}
            />
            <ConfirmAction
              actionKey={`environment:${id}:delete`}
              label="Delete"
              question={deleteQuestion(name)}
              confirmLabel="Delete"
              disabled={busy}
              onConfirm={() => removeEnvironment(key, () => plugin.request('resource.delete', { kind: 'environment', id }))}
            />
          </>
        ) : null}
      </Row>
    </Stack>
  )
}

/** `id` null : la création ; sinon l'environnement chargé dans le détail ouvert. */
export function EnvironmentFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <Row gap="sm" align="center" justify="between" wrap>
          <Button variant="ghost" size="sm" onPress={goBack}>
            ‹ Back
          </Button>
        </Row>
        <Text weight="semibold">New environment</Text>
        <EnvironmentFormBody id={null} base={emptyForm()} baseUpdatedAt={null} name="" />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'environment' || detail.id !== id) return <Spinner label="Loading details" />
  return (
    <EnvironmentFormBody
      id={id}
      base={detail.form}
      baseUpdatedAt={detail.updatedAt}
      name={clipBytes(detail.name, NAME_LIMIT_BYTES).text}
    />
  )
}
