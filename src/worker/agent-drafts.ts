// Les agents dans l'éditeur : un brouillon YAML par agent (`agents/<nom>--<id>.yaml`), lu à l'état actuel,
// envoyé avec la version lue comme garde (une version changée ailleurs devient `conflict`), puis réécrit avec
// ce que l'API a gardé. « New agent » part d'un modèle fixe (`agents/new-agent.yaml`) et, une fois créé,
// l'agent a son fichier canonique, ouvert dans l'éditeur ; le modèle revient à son état d'origine.
import Anthropic from '@anthropic-ai/sdk'
import type { AgentCreateParams, AgentUpdateParams, BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import type { ApiResult, Committed, DraftRef } from '../protocol'
import {
  NEW_AGENT_YAML,
  agentToDocument,
  changedTopLevel,
  parseAgentYaml,
  renderAgentYaml,
  type AgentDocument
} from './agent-yaml'
import { CONFLICT_MESSAGE, failure, type ClientStore } from './client'
import { diffDocuments } from './diff'
import { slugify, type DraftAdapter, type Drafts } from './drafts'

type AgentRef = Extract<DraftRef, { kind: 'agent' }>

export const NEW_AGENT_FILE = 'agents/new-agent.yaml'

const NEW_AGENT_REF: AgentRef = { kind: 'agent', agentId: null }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Le fichier d'un agent dans le dossier de brouillons : `agents/<slug du nom>--<id>.yaml`. */
export function agentFile(name: string, id: string): string {
  return `agents/${slugify(name)}--${id}.yaml`
}

/**
 * Le refus de version de l'API, sous la forme capturée le 22/11 (`t12-version-probe.log`) : un 409 dont le corps
 * est `invalid_request_error` « Concurrent modification detected. ». Tout autre 409 garde le message de l'API.
 */
export function isVersionRefusal(error: unknown): boolean {
  if (!(error instanceof Anthropic.ConflictError)) {
    return false
  }
  const body: unknown = error.error
  const inner = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof inner !== 'object' || inner === null) {
    return false
  }
  const { type, message } = inner as { type?: unknown; message?: unknown }
  return type === 'invalid_request_error' && typeof message === 'string' && message.startsWith('Concurrent modification detected')
}

/**
 * L'envoi : une mise à jour des seules clés de premier niveau changées, gardée par la version lue (sauf
 * `force`), ou une création quand il n'y a pas d'id. Appelée aussi par le formulaire de la tâche 13.
 * Les conversions de type ne viennent qu'après la validation de `name` et `model` par `parseAgentYaml`.
 */
export function sendAgent(
  client: Anthropic,
  agentId: string | null,
  version: number | null,
  before: AgentDocument,
  after: AgentDocument,
  force: boolean
): Promise<BetaManagedAgentsAgent> {
  if (agentId === null) {
    return client.beta.agents.create(after as unknown as AgentCreateParams)
  }
  const params = { ...changedTopLevel(before, after), ...(force || version === null ? {} : { version }) }
  return client.beta.agents.update(agentId, params as AgentUpdateParams)
}

export function createAgentAdapter(
  store: ClientStore,
  drafts: () => Drafts,
  log: (message: string) => void = () => {},
  now: () => Date = () => new Date()
): DraftAdapter<AgentRef> {
  const retrieve = async (agentId: string): Promise<BetaManagedAgentsAgent> => (await store.get()).beta.agents.retrieve(agentId)

  const yamlOf = (agent: BetaManagedAgentsAgent): string =>
    renderAgentYaml(agentToDocument(agent), { id: agent.id, version: agent.version, readAt: now().toISOString() })

  /** Le brouillon déjà enregistré de cet agent, retrouvé par le suffixe `--<id>.yaml`, quel que soit le slug du nom. */
  async function registeredFile(agentId: string): Promise<string | null> {
    const suffix = `--${agentId}.yaml`
    const known = await drafts().find((ref) => ref.kind === 'agent')
    const match = known.find((candidate) => candidate.file.startsWith('agents/') && candidate.file.endsWith(suffix))
    return match?.file ?? null
  }

  /**
   * L'envoi réussi, le fichier reprend ce que l'API a gardé. Rien ici ne fait échouer l'écriture, déjà faite :
   * un souci se journalise et le brouillon reste tel qu'il est (non appliqué).
   */
  async function afterSend(ref: AgentRef, agent: BetaManagedAgentsAgent, sent: string): Promise<void> {
    try {
      const created: AgentRef = { kind: 'agent', agentId: agent.id }
      const written = yamlOf(agent)
      if (ref.agentId !== null) {
        await drafts().rewrite(created, written, { version: agent.version }, sent)
        return
      }
      // Une création : le fichier canonique de l'agent reprend le workspace de retour du modèle (le focus d'Orca,
      // à ce moment, est celui des brouillons), puis s'ouvre ; le modèle revient à son état d'origine.
      const template = await drafts().state(NEW_AGENT_REF)
      const returnTo = template.ok ? (template.value?.returnTo ?? null) : null
      await drafts().rewrite(created, written, { version: agent.version }, sent, returnTo)
      await drafts().rewrite(NEW_AGENT_REF, NEW_AGENT_YAML, null, sent)
      const opened = await drafts().open(created)
      if (!opened.ok) {
        log(`agent created, but its file could not be opened: ${opened.error}`)
      }
    } catch (error) {
      log(`agent draft kept as sent, not rewritten after a successful send: ${messageOf(error)}`)
    }
  }

  /**
   * Le document que Romain a ouvert, base du différentiel : seules les clés qu'il a touchées partent, jamais celles
   * qu'un autre éditeur a changées depuis (même forcé). C'est l'agent vivant quand sa version est celle de la base ;
   * sinon la version ouverte, relue par `retrieve(id, { version })`. Si cette relecture échoue (404, rétention), la
   * version vivante sert de repli : le différentiel montre alors aussi les changements d'ailleurs.
   */
  async function openedDocument(agentId: string, base: number): Promise<AgentDocument> {
    const live = await retrieve(agentId)
    if (live.version === base) {
      return agentToDocument(live)
    }
    try {
      return agentToDocument(await (await store.get()).beta.agents.retrieve(agentId, { version: base }))
    } catch (error) {
      log(`agent ${agentId} v${base} could not be read back (${messageOf(error)}); comparing with the live v${live.version}`)
      return agentToDocument(live)
    }
  }

  /** Le refus de version : l'agent a changé ailleurs, la version actuelle est relue pour le dire. */
  async function conflictOf(agentId: string, base: number): Promise<{ ok: false; error: string; code: 'conflict' }> {
    const current = await retrieve(agentId).then(
      (agent) => agent.version,
      () => null
    )
    const error = current === null ? CONFLICT_MESSAGE : `Changed elsewhere since you opened it (v${base} → v${current}).`
    return { ok: false, error, code: 'conflict' }
  }

  return {
    async file(ref) {
      if (ref.agentId === null) {
        return NEW_AGENT_FILE
      }
      const known = await registeredFile(ref.agentId)
      if (known !== null) {
        return known
      }
      const agent = await retrieve(ref.agentId)
      return agentFile(agent.name, agent.id)
    },

    async readLive(ref) {
      if (ref.agentId === null) {
        return { text: NEW_AGENT_YAML, base: null }
      }
      const agent = await retrieve(ref.agentId)
      return { text: yamlOf(agent), base: { version: agent.version } }
    },

    async prepare(ref, text, base, stage) {
      const parsed = parseAgentYaml(text)
      if (!parsed.ok) {
        return { ok: false, code: 'invalid', error: parsed.error }
      }
      const after = parsed.doc
      let before: AgentDocument = {}
      let version: number | null = null
      if (ref.agentId !== null) {
        // Un agent existant n'est jamais écrit sans la garde de la version que le brouillon a lue : sans elle
        // (registre refait, entrée sans base), l'envoi écraserait ce que personne n'a vu.
        if (base === null || !('version' in base)) {
          return { ok: false, code: 'other', error: 'The draft file is gone: open it again.' }
        }
        version = base.version
        before = await openedDocument(ref.agentId, base.version)
      }
      const changes = diffDocuments(before, after)
      if (changes.length === 0) {
        return { ok: false, code: 'nothing_to_apply', error: 'Nothing to apply: the file matches the version you opened.' }
      }
      const commit = async (force: boolean): Promise<ApiResult<Committed>> => {
        try {
          const client = await store.get()
          const agent = await sendAgent(client, ref.agentId, version, before, after, force)
          await afterSend(ref, agent, text)
          return { ok: true, value: { label: `Applied, v${agent.version}`, id: agent.id } }
        } catch (error) {
          if (ref.agentId !== null && version !== null && isVersionRefusal(error)) {
            return conflictOf(ref.agentId, version)
          }
          return failure(error)
        }
      }
      return { ok: true, value: stage(commit, changes, ref.agentId === null) }
    }
  }
}
