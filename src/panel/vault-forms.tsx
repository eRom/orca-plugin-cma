// Formulaires du coffre et de ses identifiants : création, modification, archivage et suppression.
// La saisie en cours est gardée par `form-state` (atome persisté) ; un secret n'y entre jamais : il vit
// dans `secretDrafts` (mémoire seule) et ne rejoint le formulaire qu'au moment de l'envoi.
import {
  atom,
  Button,
  Callout,
  Checkbox,
  env,
  Field,
  Input,
  KeyValue,
  List,
  ListItem,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  set,
  Spinner,
  Stack,
  Text,
  Textarea,
  update,
  type OrcaNode
} from 'orca'
import type { ApiResult, CredentialForm, CredentialRow, CredentialType, Saved, VaultForm } from '../protocol'
import { validateCredentialForm } from '../shared/credential-rules'
import { clipBytes } from '../shared/text'
import { archiveQuestion, ConfirmAction, deleteQuestion } from './confirm'
import { configDetail, configDetailError, loadConfigs, loadDetail, openConfig, openCredential, RENDER_ROW_CAP } from './config-state'
import {
  clearForm,
  dropFieldText,
  editForm,
  editSecret,
  fieldText,
  formConflict,
  formKey,
  isTouched,
  readForm,
  secretCleared,
  secretDrafts,
  setFieldText,
  touchField
} from './form-state'
import { ERROR_TEXT_LIMIT_BYTES, loadWorkspace, nav, popIfTop, popView, run, type NavEntry } from './state'

/** Titre de l'avis d'un conflit : le même texte que celui du worker. */
const CONFLICT_TITLE = 'Changed elsewhere since you opened it.'
/** Plafonds d'un nom et d'une description repris dans un libellé : plus de 1 Kio fait refuser le rendu. */
const NAME_LIMIT_BYTES = 200
const DESCRIPTION_LIMIT_BYTES = 300

const CREDENTIAL_LABELS: Record<CredentialType, string> = {
  mcp_oauth: 'MCP OAuth',
  static_bearer: 'Static bearer',
  environment_variable: 'Environment variable'
}

const SECRET_HELP = 'Leave empty to keep the current one.'

type BearerForm = Extract<CredentialForm, { type: 'static_bearer' }>
type EnvVarForm = Extract<CredentialForm, { type: 'environment_variable' }>

const clipName = (text: string): string => clipBytes(text, NAME_LIMIT_BYTES).text

// --- État éphémère ---

/** Vrai pendant un enregistrement : un double appui ne part pas deux fois. */
const saving = atom(false)
/** Refus de l'enregistrement (hors conflit), avec le formulaire concerné. */
const saveFailure = atom<{ key: string; message: string } | null>(null)

/** Oublie la saisie gardée, le secret, le conflit et le refus de ce formulaire. */
function discardForm(key: string): void {
  clearForm(key)
  if (read(saveFailure)?.key === key) set(saveFailure, null)
}

// --- Actions ---

/**
 * Envoie un formulaire. Un conflit ouvre son avis ; un refus s'affiche (le secret tapé reste, pour
 * réessayer) ; la réussite passe à `afterSave`, qui relit ce qui a changé.
 */
async function submitForm(key: string, send: () => Promise<ApiResult<Saved>>, afterSave: (saved: Saved) => Promise<void>): Promise<void> {
  if (read(saving)) return
  set(saving, true)
  set(saveFailure, null)
  try {
    const result = await send()
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
    await afterSave(result.value)
  } finally {
    set(saving, false)
  }
}

/** Archive ou supprime, puis `afterRemove`. Un refus de l'API remonte à `ConfirmAction`. */
async function removeResource(key: string, call: () => Promise<ApiResult<null>>, afterRemove: () => Promise<void>): Promise<void> {
  const result = await call()
  if (!result.ok) throw new Error(result.error)
  discardForm(key)
  await afterRemove()
}

function goBack(): void {
  update(nav, popView)
}

/** Le formulaire de création d'un coffre est-il la vue courante ? */
const isNewVaultView = (entry: NavEntry): boolean => entry.view === 'newConfig' && entry.kind === 'vault'

/** Le formulaire de cet identifiant (`credentialId` null : la création) est-il la vue courante ? */
const isCredentialView =
  (vaultId: string, credentialId: string | null) =>
  (entry: NavEntry): boolean =>
    entry.view === 'credential' && entry.vaultId === vaultId && entry.credentialId === credentialId

/** Relit le coffre vivant et abandonne la saisie gardée. */
async function reloadForm(key: string, vaultId: string): Promise<void> {
  discardForm(key)
  await loadDetail('vault', vaultId)
}

// --- Rendu commun ---

type NoticesProps = {
  dirty: boolean
  secretLost: boolean
  conflict: boolean
  busy: boolean
  canForce: boolean
  failure: string | null
  onDiscard: () => void
  onReload: () => void
  onForce: () => void
}

/** Saisie gardée, conflit et refus d'un formulaire : le même bloc pour le coffre et l'identifiant. */
function FormNotices({ dirty, secretLost, conflict, busy, canForce, failure, onDiscard, onReload, onForce }: NoticesProps) {
  return (
    <>
      {dirty || secretLost ? (
        <Callout tone="accent">
          <Stack gap="xs">
            <Row gap="sm" align="center" justify="between" wrap>
              <Text size="sm">Unsaved changes</Text>
              <Button variant="ghost" size="sm" onPress={onDiscard}>
                Discard
              </Button>
            </Row>
            {secretLost ? <Text size="sm">Secret fields were cleared.</Text> : null}
          </Stack>
        </Callout>
      ) : null}
      {conflict ? (
        <Callout tone="warning" title={CONFLICT_TITLE}>
          <Stack gap="sm">
            <Text size="sm">Reload drops your changes. Save anyway overwrites what changed.</Text>
            <Row gap="sm" wrap>
              <Button variant="outline" size="sm" disabled={busy} onPress={onReload}>
                Reload
              </Button>
              <Button variant="solid" size="sm" disabled={busy || !canForce} onPress={onForce}>
                Save anyway
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {failure !== null ? (
        <Callout tone="danger" title="Could not save">
          <Text size="sm">{clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text}</Text>
        </Callout>
      ) : null}
    </>
  )
}

function BackRow() {
  return (
    <Row gap="sm" align="center" justify="between" wrap>
      <Button variant="ghost" size="sm" onPress={goBack}>
        ‹ Back
      </Button>
    </Row>
  )
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString(env.locale, { dateStyle: 'medium', timeStyle: 'short' })
}

// --- Coffre ---

function credentialDescription(credential: CredentialRow): string {
  const parts: string[] = [CREDENTIAL_LABELS[credential.type]]
  if (credential.mcpServerUrl) parts.push(clipBytes(credential.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text)
  if (credential.expiresAt) parts.push(`expires ${formatDate(credential.expiresAt)}`)
  return parts.join(' · ')
}

function CredentialsSection({ vaultId, credentials }: { vaultId: string; credentials: readonly CredentialRow[] }) {
  return (
    <Stack gap="xs">
      <Text size="sm" weight="medium">
        Credentials
      </Text>
      {credentials.length === 0 ? (
        <Text muted size="sm">
          No credentials yet.
        </Text>
      ) : (
        <List label="Credentials">
          {credentials.slice(0, RENDER_ROW_CAP).map((credential) => (
            <ListItem
              key={credential.id}
              title={clipName(credential.name)}
              description={credentialDescription(credential)}
              onPress={() => openCredential(vaultId, credential.id)}
            />
          ))}
        </List>
      )}
      {credentials.length > RENDER_ROW_CAP ? (
        <Text muted size="xs">
          {`Showing the first ${RENDER_ROW_CAP} of ${credentials.length}. Open in Console for the rest.`}
        </Text>
      ) : null}
      <Row>
        <Button icon="add" variant="outline" size="sm" onPress={() => openCredential(vaultId, null)}>
          Add credential
        </Button>
      </Row>
    </Stack>
  )
}

type VaultBodyProps = { id: string | null; base: VaultForm; baseUpdatedAt: string | null; name: string; credentials: readonly CredentialRow[] }

function VaultFormBody({ id, base, baseUpdatedAt, name, credentials }: VaultBodyProps) {
  const key = formKey('vault', id)
  const { form, dirty, stale } = readForm(key, base, baseUpdatedAt)
  const conflict = (read(formConflict)[key] === true || stale) && id !== null
  const busy = read(saving)
  const failed = read(saveFailure)
  const nameMissing = form.name.trim() === ''

  const save = (force: boolean): void => {
    // La base et l'horodatage envoyés sont ceux de la saisie gardée, forcée ou non (voir `readForm`).
    const draft = readForm(key, base, baseUpdatedAt)
    run(() =>
      submitForm(
        key,
        () =>
          plugin.request('vault.save', {
            id,
            baseUpdatedAt: typeof draft.baseStamp === 'string' ? draft.baseStamp : null,
            force,
            form: draft.form,
            base: id === null ? null : draft.base
          }),
        async (saved) => {
          await loadConfigs('vault')
          discardForm(key)
          if (id === null) {
            // Le détail du nouveau coffre remplace le formulaire de création, s'il est encore ouvert (sinon : Back pressé).
            if (popIfTop(isNewVaultView)) openConfig('vault', saved.id)
          } else {
            await loadDetail('vault', id)
          }
        }
      )
    )
  }

  return (
    <Stack gap="md">
      <FormNotices
        dirty={dirty}
        secretLost={false}
        conflict={conflict}
        busy={busy}
        canForce={!nameMissing}
        failure={failed?.key === key ? failed.message : null}
        onDiscard={() => discardForm(key)}
        onReload={() => id !== null && run(() => reloadForm(key, id))}
        onForce={() => save(true)}
      />
      <Input
        label="Name"
        disabled={busy}
        value={form.name}
        // L'erreur attend que la personne ait modifié le champ une fois : un formulaire neuf ne s'ouvre pas en rouge.
        invalid={nameMissing && isTouched(key, 'name')}
        onChange={(value) => {
          touchField(key, 'name')
          editForm(key, { name: value }, base, baseUpdatedAt)
        }}
      />
      <Row gap="sm" align="center" wrap>
        <Button disabled={busy || nameMissing || (id !== null && !dirty)} onPress={() => save(false)}>
          {id === null ? 'Create' : 'Save'}
        </Button>
        {id !== null ? (
          <>
            <ConfirmAction
              actionKey={`vault:${id}:archive`}
              label="Archive"
              question={archiveQuestion(name)}
              confirmLabel="Archive"
              disabled={busy}
              onConfirm={() => removeResource(key, () => plugin.request('resource.archive', { kind: 'vault', id }), () => removeVault(id))}
            />
            <ConfirmAction
              actionKey={`vault:${id}:delete`}
              label="Delete"
              question={deleteQuestion(name)}
              confirmLabel="Delete"
              disabled={busy}
              onConfirm={() => removeResource(key, () => plugin.request('resource.delete', { kind: 'vault', id }), () => removeVault(id))}
            />
          </>
        ) : null}
      </Row>
      {id !== null ? <CredentialsSection vaultId={id} credentials={credentials} /> : null}
    </Stack>
  )
}

/** Après l'archivage ou la suppression d'un coffre : retour à l'accueil, liste relue. */
async function removeVault(id: string): Promise<void> {
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'vault' && entry.id === id)
  await loadConfigs('vault')
}

/** `id` null : la création ; sinon le coffre chargé dans le détail ouvert. */
export function VaultFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <BackRow />
        <Text weight="semibold">New vault</Text>
        <VaultFormBody id={null} base={{ name: '' }} baseUpdatedAt={null} name="" credentials={[]} />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'vault' || detail.id !== id) return <Spinner label="Loading details" />
  return <VaultFormBody id={id} base={detail.form} baseUpdatedAt={detail.updatedAt} name={clipName(detail.name)} credentials={detail.credentials} />
}

// --- Identifiant ---

function emptyCredentialForm(type: 'static_bearer' | 'environment_variable', name = ''): CredentialForm {
  // L'API exige un emplacement d'injection : l'en-tête est le choix de départ.
  return type === 'static_bearer'
    ? { type, name, mcpServerUrl: '', token: '' }
    : { type, name, secretName: '', secretValue: '', network: { mode: 'unrestricted' }, injection: { header: true, body: false } }
}

/** Le formulaire avec son secret tapé : il ne sert qu'à valider et à envoyer, jamais à garder. */
function withSecret(form: CredentialForm, secret: string): CredentialForm {
  return form.type === 'static_bearer' ? { ...form, token: secret } : { ...form, secretValue: secret }
}

/** Une valeur par ligne, coupée ; les lignes vides sont ignorées. */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Le premier défaut à montrer : celui de `validateCredentialForm`, sauf s'il tient à un champ obligatoire
 * que la personne n'a pas encore touché (le bouton reste désactivé, mais rien ne s'affiche en rouge).
 */
function visibleProblem(key: string, form: CredentialForm, creating: boolean): string | null {
  const filled = (field: string, value: string): string => (value.trim() === '' && !isTouched(key, field) ? 'x' : value)
  const masked: CredentialForm =
    form.type === 'static_bearer'
      ? { ...form, mcpServerUrl: filled('url', form.mcpServerUrl), token: creating ? filled('secret', form.token) : form.token }
      : { ...form, secretName: filled('secretName', form.secretName), secretValue: creating ? filled('secret', form.secretValue) : form.secretValue }
  return validateCredentialForm(masked, creating)
}

type CredentialBodyProps = { vaultId: string; id: string | null; base: CredentialForm; baseUpdatedAt: string | null; name: string }

function CredentialFormBody({ vaultId, id, base, baseUpdatedAt, name }: CredentialBodyProps) {
  const creating = id === null
  // Deux coffres peuvent avoir chacun un nouvel identifiant en cours : la clé porte le coffre.
  const key = formKey('credential', id ?? `new@${vaultId}`)
  const { form, base: draftBase, dirty, stale } = readForm(key, base, baseUpdatedAt)
  const secret = read(secretDrafts)[key] ?? ''
  const secretLost = secretCleared(key)
  const effective = withSecret(form, secret)
  const conflict = (read(formConflict)[key] === true || stale) && !creating
  const busy = read(saving)
  const failed = read(saveFailure)
  const problem = validateCredentialForm(effective, creating)
  const shownProblem = visibleProblem(key, effective, creating)

  const latest = (): CredentialForm => readForm(key, base, baseUpdatedAt).form
  const edit = (next: CredentialForm): void => editForm(key, next, base, baseUpdatedAt)
  const changeBearer = (changes: Partial<BearerForm>): void => {
    const current = latest()
    if (current.type === 'static_bearer') edit({ ...current, ...changes })
  }
  const changeEnvVar = (changes: Partial<EnvVarForm>): void => {
    const current = latest()
    if (current.type === 'environment_variable') edit({ ...current, ...changes })
  }
  const changeName = (value: string): void => edit({ ...latest(), name: value })
  const changeSecret = (value: string): void => {
    touchField(key, 'secret')
    editSecret(key, value, latest(), base, baseUpdatedAt)
  }
  const changeType = (value: string): void => {
    if (value !== 'static_bearer' && value !== 'environment_variable') return
    if (value === latest().type) return
    dropFieldText(key, 'hosts')
    editSecret(key, '', latest(), base, baseUpdatedAt)
    edit(emptyCredentialForm(value, latest().name))
  }

  const save = (force: boolean): void => {
    // La base et l'horodatage envoyés sont ceux de la saisie gardée, forcée ou non (voir `readForm`).
    const draft = readForm(key, base, baseUpdatedAt)
    const sent = withSecret(draft.form, read(secretDrafts)[key] ?? '')
    run(() =>
      submitForm(
        key,
        () =>
          plugin.request('credential.save', {
            vaultId,
            id,
            baseUpdatedAt: typeof draft.baseStamp === 'string' ? draft.baseStamp : null,
            force,
            form: sent,
            base: id === null ? null : draft.base
          }),
        async () => {
          await loadConfigs('vault')
          // Le secret part avec la saisie : le champ revient vide.
          discardForm(key)
          // Un nouvel identifiant ramène au coffre ; une modification reste sur le formulaire relu.
          if (creating) popIfTop(isCredentialView(vaultId, null))
          await loadDetail('vault', vaultId)
        }
      )
    )
  }

  const secretLabel = creating ? (form.type === 'static_bearer' ? 'Token' : 'Value') : form.type === 'static_bearer' ? 'Replace token' : 'Replace value'
  const secretInput = (
    <Input
      label={secretLabel}
      labelHidden={!creating}
      type="password"
      disabled={busy}
      value={secret}
      invalid={creating && secret.trim() === '' && isTouched(key, 'secret')}
      onChange={changeSecret}
    />
  )

  return (
    <Stack gap="md">
      <FormNotices
        dirty={dirty || secret !== ''}
        secretLost={secretLost}
        conflict={conflict}
        busy={busy}
        canForce={problem === null}
        failure={failed?.key === key ? failed.message : null}
        onDiscard={() => discardForm(key)}
        onReload={() => run(() => reloadForm(key, vaultId))}
        onForce={() => save(true)}
      />
      {creating ? (
        <Select
          label="Type"
          disabled={busy}
          value={form.type}
          options={[
            { value: 'static_bearer', label: 'Bearer token' },
            { value: 'environment_variable', label: 'Environment variable' },
            { value: 'mcp_oauth', label: 'MCP OAuth (later version)', disabled: true }
          ]}
          onChange={changeType}
        />
      ) : (
        <Text size="sm">{`Type: ${CREDENTIAL_LABELS[form.type]}`}</Text>
      )}
      <Input
        label="Name"
        placeholder="Optional"
        disabled={busy}
        value={form.name}
        onChange={(value) => {
          touchField(key, 'name')
          changeName(value)
        }}
      />
      {form.type === 'static_bearer' ? (
        creating ? (
          <Input
            label="MCP server URL"
            disabled={busy}
            value={form.mcpServerUrl}
            invalid={form.mcpServerUrl.trim() === '' && isTouched(key, 'url')}
            onChange={(value) => {
              touchField(key, 'url')
              changeBearer({ mcpServerUrl: value })
            }}
          />
        ) : (
          // L'URL se fixe à la création : l'API ignore un changement.
          <Text size="sm">{`MCP server URL: ${clipBytes(form.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text}`}</Text>
        )
      ) : creating ? (
        <Input
          label="Variable name"
          disabled={busy}
          value={form.secretName}
          invalid={form.secretName.trim() === '' && isTouched(key, 'secretName')}
          onChange={(value) => {
            touchField(key, 'secretName')
            changeEnvVar({ secretName: value })
          }}
        />
      ) : (
        <Text size="sm">{`Variable name: ${clipName(form.secretName)}`}</Text>
      )}
      {creating ? secretInput : <Field label={secretLabel} description={SECRET_HELP}>{secretInput}</Field>}
      {form.type === 'environment_variable' ? (
        <>
          <RadioGroup
            label="Network"
            disabled={busy}
            value={form.network.mode}
            options={[
              { value: 'unrestricted', label: 'Unrestricted' },
              { value: 'limited', label: 'Limited' }
            ]}
            onChange={(mode) => {
              dropFieldText(key, 'hosts')
              // Revenir à `Limited` retrouve les hôtes du chargement, s'il y en avait.
              const previous = draftBase.type === 'environment_variable' ? draftBase.network : null
              changeEnvVar({ network: mode === 'limited' ? (previous?.mode === 'limited' ? previous : { mode: 'limited', allowedHosts: [] }) : { mode: 'unrestricted' } })
            }}
          />
          {form.network.mode === 'limited' ? (
            <Textarea
              label="Allowed hosts"
              placeholder="One host per line"
              disabled={busy}
              rows={4}
              value={fieldText(key, 'hosts', form.network.allowedHosts.join('\n'))}
              onChange={(text) => {
                setFieldText(key, 'hosts', text)
                changeEnvVar({ network: { mode: 'limited', allowedHosts: parseLines(text) } })
              }}
            />
          ) : null}
          <Stack gap="xs">
            <Checkbox
              label="Inject in header"
              disabled={busy}
              checked={form.injection.header}
              onChange={(checked) => changeEnvVar({ injection: { ...form.injection, header: checked } })}
            />
            <Checkbox
              label="Inject in body"
              disabled={busy}
              checked={form.injection.body}
              onChange={(checked) => changeEnvVar({ injection: { ...form.injection, body: checked } })}
            />
          </Stack>
        </>
      ) : null}
      {shownProblem !== null ? (
        <Text tone="danger" size="sm">
          {shownProblem}
        </Text>
      ) : null}
      <Row gap="sm" align="center" wrap>
        <Button disabled={busy || problem !== null || (!creating && !dirty && secret === '')} onPress={() => save(false)}>
          {creating ? 'Create' : 'Save'}
        </Button>
        {id !== null ? <RemoveActions vaultId={vaultId} id={id} name={name} busy={busy} formKeyOf={key} /> : null}
      </Row>
    </Stack>
  )
}

/** « Archive » et « Delete » d'un identifiant : retour au coffre relu, puis la liste des coffres. */
function RemoveActions({ vaultId, id, name, busy, formKeyOf }: { vaultId: string; id: string; name: string; busy: boolean; formKeyOf: string }) {
  const afterRemove = async (): Promise<void> => {
    popIfTop(isCredentialView(vaultId, id))
    await Promise.all([loadDetail('vault', vaultId), loadConfigs('vault')])
  }
  return (
    <>
      <ConfirmAction
        actionKey={`credential:${id}:archive`}
        label="Archive"
        question={archiveQuestion(name)}
        confirmLabel="Archive"
        disabled={busy}
        onConfirm={() => removeResource(formKeyOf, () => plugin.request('resource.archive', { kind: 'credential', vaultId, id }), afterRemove)}
      />
      <ConfirmAction
        actionKey={`credential:${id}:delete`}
        label="Delete"
        question={deleteQuestion(name)}
        confirmLabel="Delete"
        disabled={busy}
        onConfirm={() => removeResource(formKeyOf, () => plugin.request('resource.delete', { kind: 'credential', vaultId, id }), afterRemove)}
      />
    </>
  )
}

/** Un identifiant `mcp_oauth` : lu seulement, avec Archive et Delete. */
function CredentialReadOnly({ vaultId, credential }: { vaultId: string; credential: CredentialRow }) {
  const key = formKey('credential', credential.id)
  return (
    <Stack gap="md">
      <KeyValue
        label="Credential"
        items={[
          { label: 'Type', value: CREDENTIAL_LABELS[credential.type] },
          ...(credential.mcpServerUrl ? [{ label: 'MCP server URL', value: clipBytes(credential.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text }] : []),
          ...(credential.expiresAt ? [{ label: 'Expires', value: formatDate(credential.expiresAt) }] : [])
        ]}
      />
      <Row gap="sm" align="center" wrap>
        <RemoveActions vaultId={vaultId} id={credential.id} name={clipName(credential.name)} busy={false} formKeyOf={key} />
      </Row>
    </Stack>
  )
}

/** `credentialId` null : la création ; sinon l'identifiant du coffre chargé dans le détail ouvert. */
export function CredentialFormView({ vaultId, credentialId }: { vaultId: string; credentialId: string | null }): OrcaNode {
  const detail = read(configDetail)
  const failure = read(configDetailError)
  if (detail?.kind !== 'vault' || detail.id !== vaultId) {
    return (
      <Stack gap="md">
        <BackRow />
        {failure ? (
          <Callout tone="danger" title="Could not load the details">
            <Text size="sm">{clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text}</Text>
          </Callout>
        ) : (
          <Spinner label="Loading details" />
        )}
      </Stack>
    )
  }
  if (credentialId === null) {
    return (
      <Stack gap="md">
        <BackRow />
        <Text weight="semibold">New credential</Text>
        <CredentialFormBody vaultId={vaultId} id={null} base={emptyCredentialForm('static_bearer')} baseUpdatedAt={null} name="" />
      </Stack>
    )
  }
  const credential = detail.credentials.find((row) => row.id === credentialId)
  if (!credential) {
    return (
      <Stack gap="md">
        <BackRow />
        <Text size="sm">This credential no longer exists.</Text>
      </Stack>
    )
  }
  const name = clipName(credential.name)
  return (
    <Stack gap="md">
      <BackRow />
      <Text weight="semibold">{name}</Text>
      {credential.form === null ? (
        <CredentialReadOnly vaultId={vaultId} credential={credential} />
      ) : (
        <CredentialFormBody vaultId={vaultId} id={credential.id} base={credential.form} baseUpdatedAt={credential.updatedAt} name={name} />
      )}
    </Stack>
  )
}
