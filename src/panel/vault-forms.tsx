// Formulaires du coffre et de ses identifiants : création, modification, archivage et suppression.
// La saisie en cours est gardée par `form-state` (atome persisté) ; un secret n'y entre jamais : il vit
// dans `secretDrafts` (mémoire seule) et ne rejoint le formulaire qu'au moment de l'envoi.
import {
  atom,
  Box,
  Button,
  Callout,
  Checkbox,
  env,
  Field,
  Input,
  KeyValue,
  plugin,
  RadioGroup,
  read,
  Row,
  Select,
  Separator,
  set,
  Stack,
  Text,
  Textarea,
  update,
  type OrcaNode
} from 'orca'
import { ActionRow } from '../blocks/action-row'
import { BackHeader } from '../blocks/back-header'
import { EmptyView } from '../blocks/empty-view'
import { ErrorRetry } from '../blocks/error-retry'
import { FormSection } from '../blocks/form-section'
import { GroupCard } from '../blocks/group-card'
import { ItemRow } from '../blocks/item-row'
import { LoadingState } from '../blocks/loading-state'
import type { ApiResult, CredentialForm, CredentialRow, CredentialType, Saved, VaultForm } from '../protocol'
import { validateCredentialForm } from '../shared/credential-rules'
import { clipBytes } from '../shared/text'
import { archiveQuestion, askConfirmation, ConfirmPanel, deleteQuestion } from './confirm'
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

/** Archive ou supprime, puis `afterRemove`. Un refus de l'API remonte à `ConfirmPanel`. */
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

/** L'avis d'un conflit : le même pour le coffre et l'identifiant. */
function ConflictNotice({ busy, canForce, onReload, onForce }: { busy: boolean; canForce: boolean; onReload: () => void; onForce: () => void }) {
  return (
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
  )
}

/** Archiver et supprimer : en bas de l'écran, une rangée à part avec sa confirmation. */
function RemoveRow({ actionKey, name, busy, onArchive, onDelete }: { actionKey: string; name: string; busy: boolean; onArchive: () => Promise<void>; onDelete: () => Promise<void> }) {
  const archiveKey = `${actionKey}:archive`
  const deleteKey = `${actionKey}:delete`
  return (
    <Stack gap="sm">
      <Separator />
      <ActionRow
        actions={[
          { key: 'archive', label: 'Archive', disabled: busy, onPress: () => askConfirmation(archiveKey) },
          { key: 'delete', label: 'Delete', tone: 'danger', disabled: busy, onPress: () => askConfirmation(deleteKey) }
        ]}
      />
      <ConfirmPanel actionKey={archiveKey} question={archiveQuestion(name)} confirmLabel="Archive" disabled={busy} onConfirm={onArchive} />
      <ConfirmPanel actionKey={deleteKey} question={deleteQuestion(name)} confirmLabel="Delete" disabled={busy} onConfirm={onDelete} />
    </Stack>
  )
}

function formatDate(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  return new Date(time).toLocaleString(env.locale, { dateStyle: 'medium', timeStyle: 'short' })
}

// --- Coffre ---

/** Le nom d'un identifiant, ou son type quand il n'en a pas : une ligne n'a jamais de titre vide. */
function credentialTitle(credential: CredentialRow): string {
  return credential.name.trim() === '' ? CREDENTIAL_LABELS[credential.type] : clipName(credential.name)
}

function credentialDescription(credential: CredentialRow): string {
  const parts: string[] = [CREDENTIAL_LABELS[credential.type]]
  if (credential.mcpServerUrl) parts.push(clipBytes(credential.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text)
  if (credential.expiresAt) parts.push(`expires ${formatDate(credential.expiresAt)}`)
  return parts.join(' · ')
}

function CredentialsSection({ vaultId, credentials }: { vaultId: string; credentials: readonly CredentialRow[] }) {
  return (
    <Stack gap="sm">
      <GroupCard
        title="Credentials"
        rows={
          credentials.length === 0
            ? [<EmptyView kind="list" text="No credentials yet." />]
            : credentials.slice(0, RENDER_ROW_CAP).map((credential) => ({
                key: credential.id,
                row: (
                  <ItemRow
                    title={credentialTitle(credential)}
                    subtitle={credentialDescription(credential)}
                    actions={[{ key: 'open', icon: 'next', label: `Open ${credentialTitle(credential)}`, onPress: () => openCredential(vaultId, credential.id) }]}
                  />
                )
              }))
        }
      />
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

type VaultBodyProps = { id: string | null; base: VaultForm; baseUpdatedAt: string | null }

/** Le nom du coffre sous son Save ; `Discard` n'apparaît que sur une saisie modifiée. */
function VaultFormBody({ id, base, baseUpdatedAt }: VaultBodyProps) {
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
    <FormSection
      title={id === null ? undefined : 'Details'}
      saveLabel={id === null ? 'Create' : 'Save'}
      // `busy` grise Save : il dit aussi « rien à enregistrer » (saisie intacte) et « nom manquant ».
      busy={busy || nameMissing || (id !== null && !dirty)}
      error={failed?.key === key ? clipBytes(failed.message, ERROR_TEXT_LIMIT_BYTES).text : undefined}
      errorTitle="Could not save"
      onSave={() => save(false)}
      cancelLabel="Discard"
      onCancel={dirty ? () => discardForm(key) : undefined}
    >
      {[
        conflict && id !== null ? (
          <ConflictNotice key="conflict" busy={busy} canForce={!nameMissing} onReload={() => run(() => reloadForm(key, id))} onForce={() => save(true)} />
        ) : null,
        <Input
          key="name"
          label="Name"
          disabled={busy}
          value={form.name}
          // L'erreur attend que la personne ait modifié le champ une fois : un formulaire neuf ne s'ouvre pas en rouge.
          invalid={nameMissing && isTouched(key, 'name')}
          onChange={(value) => {
            touchField(key, 'name')
            editForm(key, { name: value }, base, baseUpdatedAt)
          }}
        />,
        dirty ? (
          <Text key="dirty" muted size="xs">
            Unsaved changes
          </Text>
        ) : null
      ]}
    </FormSection>
  )
}

/** Après l'archivage ou la suppression d'un coffre : retour à l'accueil, liste relue. */
async function removeVault(id: string): Promise<void> {
  popIfTop((entry) => entry.view === 'config' && entry.kind === 'vault' && entry.id === id)
  await loadConfigs('vault')
}

/** `id` null : la création ; sinon le coffre chargé dans le détail ouvert (son en-tête est celui de `ConfigDetailView`). */
export function VaultFormView({ id }: { id: string | null }): OrcaNode {
  if (id === null) {
    return (
      <Stack gap="md">
        <BackHeader title="New vault" onBack={goBack} />
        <VaultFormBody id={null} base={{ name: '' }} baseUpdatedAt={null} />
      </Stack>
    )
  }
  const detail = read(configDetail)
  if (detail?.kind !== 'vault' || detail.id !== id) return <LoadingState kind="operation" label="Loading details" />
  const key = formKey('vault', id)
  return (
    <Stack gap="lg">
      <VaultFormBody id={id} base={detail.form} baseUpdatedAt={detail.updatedAt} />
      <CredentialsSection vaultId={id} credentials={detail.credentials} />
      <RemoveRow
        actionKey={`vault:${id}`}
        name={clipName(detail.name)}
        busy={read(saving)}
        onArchive={() => removeResource(key, () => plugin.request('resource.archive', { kind: 'vault', id }), () => removeVault(id))}
        onDelete={() => removeResource(key, () => plugin.request('resource.delete', { kind: 'vault', id }), () => removeVault(id))}
      />
    </Stack>
  )
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

type CredentialBodyProps = { vaultId: string; id: string | null; base: CredentialForm; baseUpdatedAt: string | null }

function CredentialFormBody({ vaultId, id, base, baseUpdatedAt }: CredentialBodyProps) {
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

  // Ce qui se fixe à la création (le type, l'URL du serveur, le nom de la variable) se lit ensuite, l'API ignore un changement.
  const fixed: { label: string; value: string }[] = creating
    ? []
    : [
        { label: 'Type', value: CREDENTIAL_LABELS[form.type] },
        form.type === 'static_bearer'
          ? { label: 'MCP server URL', value: clipBytes(form.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text }
          : { label: 'Variable name', value: clipName(form.secretName) }
      ]
  const touched = dirty || secret !== ''

  return (
    <FormSection
      saveLabel={creating ? 'Create' : 'Save'}
      busy={busy || problem !== null || (!creating && !touched)}
      error={failed?.key === key ? clipBytes(failed.message, ERROR_TEXT_LIMIT_BYTES).text : undefined}
      errorTitle="Could not save"
      onSave={() => save(false)}
      cancelLabel="Discard"
      onCancel={touched || secretLost ? () => discardForm(key) : undefined}
    >
      {[
        conflict ? <ConflictNotice key="conflict" busy={busy} canForce={problem === null} onReload={() => run(() => reloadForm(key, vaultId))} onForce={() => save(true)} /> : null,
        creating ? (
          <Select
            key="type"
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
          <KeyValue key="fixed" label="Credential" items={fixed} />
        ),
        <Input
          key="name"
          label="Name"
          placeholder="Optional"
          disabled={busy}
          value={form.name}
          onChange={(value) => {
            touchField(key, 'name')
            changeName(value)
          }}
        />,
        creating && form.type === 'static_bearer' ? (
          <Input
            key="url"
            label="MCP server URL"
            disabled={busy}
            value={form.mcpServerUrl}
            invalid={form.mcpServerUrl.trim() === '' && isTouched(key, 'url')}
            onChange={(value) => {
              touchField(key, 'url')
              changeBearer({ mcpServerUrl: value })
            }}
          />
        ) : null,
        creating && form.type === 'environment_variable' ? (
          <Input
            key="variable"
            label="Variable name"
            disabled={busy}
            value={form.secretName}
            invalid={form.secretName.trim() === '' && isTouched(key, 'secretName')}
            onChange={(value) => {
              touchField(key, 'secretName')
              changeEnvVar({ secretName: value })
            }}
          />
        ) : null,
        creating ? (
          <Box key="secret">{secretInput}</Box>
        ) : (
          <Field key="secret" label={secretLabel} description={SECRET_HELP}>
            {secretInput}
          </Field>
        ),
        form.type === 'environment_variable' ? (
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
              </Box>,
              form.network.mode === 'limited' ? (
                <Box paddingY="xs">
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
                </Box>
              ) : null
            ]}
          />
        ) : null,
        form.type === 'environment_variable' ? (
          <GroupCard
            key="injection"
            title="Injection"
            rows={[
              <Box paddingY="xs">
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
              </Box>
            ]}
          />
        ) : null,
        shownProblem !== null ? (
          <Text key="problem" tone="danger" size="sm">
            {shownProblem}
          </Text>
        ) : null,
        secretLost ? (
          <Text key="secret-lost" muted size="xs">
            Secret fields were cleared.
          </Text>
        ) : null,
        touched ? (
          <Text key="dirty" muted size="xs">
            Unsaved changes
          </Text>
        ) : null
      ]}
    </FormSection>
  )
}

/** « Archive » et « Delete » d'un identifiant : retour au coffre relu, puis la liste des coffres. */
function CredentialRemoveRow({ vaultId, id, name, formKeyOf }: { vaultId: string; id: string; name: string; formKeyOf: string }) {
  const afterRemove = async (): Promise<void> => {
    popIfTop(isCredentialView(vaultId, id))
    await Promise.all([loadDetail('vault', vaultId), loadConfigs('vault')])
  }
  return (
    <RemoveRow
      actionKey={`credential:${id}`}
      name={name}
      busy={read(saving)}
      onArchive={() => removeResource(formKeyOf, () => plugin.request('resource.archive', { kind: 'credential', vaultId, id }), afterRemove)}
      onDelete={() => removeResource(formKeyOf, () => plugin.request('resource.delete', { kind: 'credential', vaultId, id }), afterRemove)}
    />
  )
}

/** Un identifiant `mcp_oauth` : lu seulement. */
function CredentialReadOnly({ credential }: { credential: CredentialRow }) {
  return (
    <KeyValue
      label="Credential"
      items={[
        { label: 'Type', value: CREDENTIAL_LABELS[credential.type] },
        ...(credential.mcpServerUrl ? [{ label: 'MCP server URL', value: clipBytes(credential.mcpServerUrl, DESCRIPTION_LIMIT_BYTES).text }] : []),
        ...(credential.expiresAt ? [{ label: 'Expires', value: formatDate(credential.expiresAt) }] : [])
      ]}
    />
  )
}

/** `credentialId` null : la création ; sinon l'identifiant du coffre chargé dans le détail ouvert. */
export function CredentialFormView({ vaultId, credentialId }: { vaultId: string; credentialId: string | null }): OrcaNode {
  const detail = read(configDetail)
  const failure = read(configDetailError)
  if (detail?.kind !== 'vault' || detail.id !== vaultId) {
    return (
      <Stack gap="md">
        <BackHeader title={credentialId === null ? 'New credential' : 'Credential'} onBack={goBack} />
        {failure ? (
          <ErrorRetry title="Could not load the details" message={clipBytes(failure, ERROR_TEXT_LIMIT_BYTES).text} onRetry={() => run(() => loadDetail('vault', vaultId))} />
        ) : (
          <LoadingState kind="operation" label="Loading details" />
        )}
      </Stack>
    )
  }
  if (credentialId === null) {
    return (
      <Stack gap="md">
        <BackHeader title="New credential" subtitle={clipName(detail.name)} onBack={goBack} />
        <CredentialFormBody vaultId={vaultId} id={null} base={emptyCredentialForm('static_bearer')} baseUpdatedAt={null} />
      </Stack>
    )
  }
  const credential = detail.credentials.find((row) => row.id === credentialId)
  if (!credential) {
    return (
      <Stack gap="md">
        <BackHeader title="Credential" onBack={goBack} />
        <EmptyView kind="panel" title="This credential no longer exists" description="It was archived or deleted elsewhere." />
      </Stack>
    )
  }
  const key = formKey('credential', credential.id)
  return (
    <Stack gap="lg">
      <BackHeader title={credentialTitle(credential)} subtitle={clipName(credential.id)} onBack={goBack} />
      {credential.form === null ? (
        <CredentialReadOnly credential={credential} />
      ) : (
        <CredentialFormBody vaultId={vaultId} id={credential.id} base={credential.form} baseUpdatedAt={credential.updatedAt} />
      )}
      <CredentialRemoveRow vaultId={vaultId} id={credential.id} name={credentialTitle(credential)} formKeyOf={key} />
    </Stack>
  )
}
