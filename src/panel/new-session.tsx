// Formulaire de création d'une session : l'agent, l'env et le budget sont montrés avant tout lancement.
// Rien n'est persisté ici (seule la pile `nav` l'est) : une session est facturée, donc le formulaire
// repart vierge après un redémarrage et ne lance que des ids présents dans les listes fraîchement lues.
import { atom, Button, Callout, Checkbox, Input, plugin, read, Row, Select, set, Spinner, Stack, Text, Textarea, update } from 'orca'
import { DEFAULT_BUDGET_DOLLARS, type ConfigRow, type CreateFormOptions } from '../protocol'
import { dollarsToMinor } from '../shared/money'
import { clipBytes } from '../shared/text'
import { openSession } from './session-view'
import { ERROR_TEXT_LIMIT_BYTES, nav, popView, pushView, run } from './state'

/** Plafond d'un nom dans le libellé du bouton : un libellé de plus de 1 Kio fait refuser le rendu. */
const LABEL_NAME_LIMIT_BYTES = 80
/** Délai d'une création de session : plus long que le défaut d'Orca, la première lecture d'un agent peut traîner. */
const CREATE_TIMEOUT_MS = 120_000

const options = atom<CreateFormOptions | null>(null)
const agentId = atom('')
const environmentId = atom('')
const title = atom('')
const vaultIds = atom<string[]>([])
const memoryStoreIds = atom<string[]>([])
const budget = atom(DEFAULT_BUDGET_DOLLARS)
const firstMessage = atom('')
/** Vrai pendant la création : une session est facturée, un double appui coûte. */
const creating = atom(false)
/** Erreur de lecture des listes du formulaire : son propre avis, avec un bouton pour réessayer. */
const optionsFailure = atom<string | null>(null)
/** Erreur de création, hors `model_not_budgetable`. */
const failure = atom<string | null>(null)
/** Le refus `model_not_budgetable`, avec le texte de l'API : le formulaire propose de créer sans budget. */
const notBudgetable = atom<string | null>(null)

function resetForm(): void {
  set(options, null)
  set(agentId, '')
  set(environmentId, '')
  set(title, '')
  set(vaultIds, [])
  set(memoryStoreIds, [])
  set(budget, DEFAULT_BUDGET_DOLLARS)
  set(firstMessage, '')
  set(creating, false)
  set(optionsFailure, null)
  set(failure, null)
  set(notBudgetable, null)
}

/** Lit les listes du formulaire (agents, envs, coffres, banques de mémoire). */
export async function loadFormOptions(): Promise<void> {
  set(optionsFailure, null)
  const result = await plugin.request('createForm.options')
  if (result.ok) {
    set(options, result.value)
  } else {
    set(optionsFailure, result.error)
  }
}

/** Ouvre le formulaire depuis une autre vue : formulaire vierge, pile empilée, listes lues. */
export function openNewSession(): void {
  resetForm()
  update(nav, (stack) => pushView(stack, { view: 'newSession' }))
  run(loadFormOptions)
}

/** Au redémarrage du panneau, la pile persistée peut avoir le formulaire au sommet : il repart vierge, les listes se relisent. */
export async function restoreNewSession(): Promise<void> {
  if (read(nav).at(-1)?.view === 'newSession') {
    resetForm()
    await loadFormOptions()
  }
}

function goBack(): void {
  resetForm()
  update(nav, popView)
}

/** `'none'` force une session sans plafond (bouton `Create without budget`) ; `'typed'` envoie le budget saisi. */
async function createSession(budgetOverride: 'typed' | 'none'): Promise<void> {
  if (read(creating)) return
  const typedBudget = read(budget).trim()
  if (budgetOverride === 'typed' && typedBudget !== '' && dollarsToMinor(typedBudget) === null) return
  const form = read(options)
  const agent = read(agentId)
  const environment = read(environmentId)
  // Seuls des ids présents dans les listes lues partent : jamais une ressource que l'on ne voit pas.
  if (!form || !form.agents.some((row) => row.id === agent) || !form.environments.some((row) => row.id === environment)) return
  set(creating, true)
  set(failure, null)
  set(notBudgetable, null)
  try {
    // Le worker ne réessaie jamais seul une création (facturée) : on laisse au premier essai le temps de finir.
    const result = await plugin.request(
      'session.create',
      {
        agentId: agent,
        environmentId: environment,
        title: read(title).trim() || null,
        vaultIds: read(vaultIds).filter((id) => form.vaults.some((row) => row.id === id)),
        memoryStoreIds: read(memoryStoreIds).filter((id) => form.memoryStores.some((row) => row.id === id)),
        budgetDollars: budgetOverride === 'none' || typedBudget === '' ? null : typedBudget,
        firstMessage: read(firstMessage).trim() || null
      },
      { timeoutMs: CREATE_TIMEOUT_MS }
    )
    if (!result.ok) {
      if (result.code === 'model_not_budgetable') {
        set(notBudgetable, clipBytes(result.error, ERROR_TEXT_LIMIT_BYTES).text)
      } else {
        set(failure, result.error)
      }
      return
    }
    // La vue de la nouvelle session remplace le formulaire.
    resetForm()
    update(nav, popView)
    openSession(result.value.sessionId)
  } finally {
    set(creating, false)
  }
}

function toggleId(atomToUpdate: typeof vaultIds, id: string, checked: boolean): void {
  update(atomToUpdate, (current) => (checked ? [...current.filter((known) => known !== id), id] : current.filter((known) => known !== id)))
}

function asOptions(rows: readonly ConfigRow[]): { value: string; label: string }[] {
  return rows.map((row) => ({ value: row.id, label: clipBytes(row.name, LABEL_NAME_LIMIT_BYTES * 2).text }))
}

/** Erreur brute de l'API : le titre reste un libellé fixe, le texte va en enfant. */
function ErrorText({ message }: { message: string }) {
  return <Text size="sm">{clipBytes(message, ERROR_TEXT_LIMIT_BYTES).text}</Text>
}

function CheckList({ label, rows, selected, target }: { label: string; rows: readonly ConfigRow[]; selected: string[]; target: typeof vaultIds }) {
  return (
    <Stack gap="xs">
      <Text size="sm" weight="medium">
        {label}
      </Text>
      {rows.length === 0 ? (
        <Text muted size="sm">
          None in this workspace.
        </Text>
      ) : (
        rows.map((row) => (
          <Checkbox
            key={row.id}
            label={clipBytes(row.name, LABEL_NAME_LIMIT_BYTES * 2).text}
            {...(row.summary ? { description: clipBytes(row.summary, 200).text } : {})}
            checked={selected.includes(row.id)}
            onChange={(checked) => toggleId(target, row.id, checked)}
          />
        ))
      )}
    </Stack>
  )
}

export function NewSessionView() {
  const form = read(options)
  const agent = read(agentId)
  const environment = read(environmentId)
  const typedBudget = read(budget).trim()
  const budgetInvalid = typedBudget !== '' && dollarsToMinor(typedBudget) === null
  const busy = read(creating)
  const agentName = form?.agents.find((row) => row.id === agent)?.name
  const environmentName = form?.environments.find((row) => row.id === environment)?.name
  // Prêt seulement si l'agent et l'env existent dans les listes lues : jamais sur un id que l'on ne voit pas.
  const ready = Boolean(agentName && environmentName)
  const summary =
    agentName && environmentName
      ? [
          clipBytes(agentName, LABEL_NAME_LIMIT_BYTES).text,
          clipBytes(environmentName, LABEL_NAME_LIMIT_BYTES).text,
          typedBudget === '' ? 'no budget' : `$${clipBytes(typedBudget, 20).text}`
        ].join(' · ')
      : null
  const problem = read(failure)
  const refused = read(notBudgetable)
  const listsFailure = read(optionsFailure)
  return (
    <Stack gap="md">
      <Row gap="sm" align="center" justify="between" wrap>
        <Button variant="ghost" size="sm" onPress={goBack}>
          ‹ Back
        </Button>
      </Row>
      <Text weight="semibold">New session</Text>
      {problem ? (
        <Callout tone="danger" title="Could not create the session">
          <ErrorText message={problem} />
        </Callout>
      ) : null}
      {listsFailure ? (
        <Callout tone="danger" title="Could not load the lists">
          <Stack gap="sm">
            <ErrorText message={listsFailure} />
            <Row>
              <Button variant="outline" size="sm" onPress={() => run(loadFormOptions)}>
                Retry
              </Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {form === null ? (
        listsFailure ? null : <Spinner label="Loading agents and environments" />
      ) : (
        <Stack gap="md">
          <Select
            label="Agent"
            placeholder="Choose an agent"
            value={agent}
            options={asOptions(form.agents)}
            onChange={(value) => {
              set(agentId, value)
              // Le refus vaut pour le modèle de l'agent d'avant : un autre agent efface l'avertissement.
              set(notBudgetable, null)
            }}
          />
          <Select
            label="Environment"
            placeholder="Choose an environment"
            value={environment}
            options={asOptions(form.environments)}
            onChange={(value) => set(environmentId, value)}
          />
          <Input label="Title" placeholder="Optional" value={read(title)} onChange={(value) => set(title, value)} />
          <CheckList label="Vaults" rows={form.vaults} selected={read(vaultIds)} target={vaultIds} />
          <CheckList label="Memory stores" rows={form.memoryStores} selected={read(memoryStoreIds)} target={memoryStoreIds} />
          <Input
            label="Budget (USD)"
            placeholder="Empty means no budget"
            value={read(budget)}
            invalid={budgetInvalid}
            onChange={(value) => set(budget, value)}
          />
          {budgetInvalid ? (
            <Text tone="danger" size="sm">
              The budget must be a positive amount in dollars, with at most two decimals.
            </Text>
          ) : null}
          <Textarea
            label="First message"
            placeholder="Optional"
            rows={4}
            value={read(firstMessage)}
            onChange={(value) => set(firstMessage, value)}
          />
          {refused ? (
            <Callout tone="warning" title="This model cannot run with a budget">
              <Stack gap="sm">
                <ErrorText message={refused} />
                <Row>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onPress={() => {
                      // Le champ suit le choix : la session part sans plafond.
                      set(budget, '')
                      run(() => createSession('none'))
                    }}
                  >
                    Create without budget
                  </Button>
                </Row>
              </Stack>
            </Callout>
          ) : null}
          <Button disabled={!ready || budgetInvalid || busy} onPress={() => run(() => createSession('typed'))}>
            {summary ? `Create session · ${summary}` : 'Create session'}
          </Button>
        </Stack>
      )}
    </Stack>
  )
}
