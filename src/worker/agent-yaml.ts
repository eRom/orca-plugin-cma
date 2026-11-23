// Un agent en YAML : le texte que Romain édite dans l'éditeur d'Orca. Le document est la réponse de l'API,
// comme la vue « Brut » de la console, sans les champs que le serveur seul pose ; l'écriture n'envoie que
// les clés de premier niveau qui diffèrent de l'agent vivant.
import type { BetaManagedAgentsAgent } from '@anthropic-ai/sdk/resources/beta/agents/agents'
import { isDeepStrictEqual } from 'node:util'
import { YAMLParseError, parse, stringify } from 'yaml'

/** L'ordre des clés de premier niveau, celui de la console. */
export const AGENT_KEY_ORDER = ['name', 'model', 'description', 'system', 'mcp_servers', 'tools', 'skills', 'multiagent', 'metadata'] as const

export type AgentDocument = Record<string, unknown>

/** Les champs que le serveur pose et que Romain ne modifie pas : absents du fichier. */
const SERVER_KEYS = new Set(['archived_at', 'created_at', 'execution_identity', 'id', 'type', 'updated_at', 'version'])

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * L'agent de l'API en document : les clés connues dans l'ordre de la console, `multiagent` seulement s'il n'est
 * pas `null`, puis toute autre clé de la réponse par ordre alphabétique (aucune ne se perd en silence).
 */
export function agentToDocument(agent: BetaManagedAgentsAgent): AgentDocument {
  const source = agent as unknown as Record<string, unknown>
  const known = new Set<string>(AGENT_KEY_ORDER)
  const doc: AgentDocument = {}
  for (const key of AGENT_KEY_ORDER) {
    const value = source[key]
    if (value === undefined || (key === 'multiagent' && value === null)) {
      continue
    }
    doc[key] = value
  }
  for (const key of Object.keys(source).sort()) {
    if (!known.has(key) && !SERVER_KEYS.has(key) && source[key] !== undefined) {
      doc[key] = source[key]
    }
  }
  return doc
}

/**
 * Le texte du fichier. `lineWidth: 0` interdit tout repli de ligne et `blockQuote: 'literal'` écrit un texte à
 * plusieurs lignes en bloc `|` : le prompt système se lit et se modifie tel quel, et revient octet pour octet.
 */
export function renderAgentYaml(doc: AgentDocument, header: { id: string; version: number; readAt: string } | null): string {
  const body = stringify(doc, { lineWidth: 0, blockQuote: 'literal' })
  if (header === null) {
    return body
  }
  return `# Agent ${header.id} · version ${header.version} · read ${header.readAt}\n# Edit, save (⌘S), then press Apply in the Managed Agents panel.\n${body}`
}

/** La syntaxe se lit avec `yaml` ; `linePos` porte la ligne et la colonne (à partir de 1) de l'erreur. */
function syntaxError(error: unknown): string {
  if (error instanceof YAMLParseError) {
    const message = error.message.split(' at line ')[0]
    const position = error.linePos?.[0]
    return position ? `YAML error at line ${position.line}, column ${position.col}: ${message}` : `YAML error: ${message}`
  }
  return `YAML error: ${error instanceof Error ? error.message : String(error)}`
}

const isBlank = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

export function parseAgentYaml(text: string): { ok: true; doc: AgentDocument } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch (error) {
    return { ok: false, error: syntaxError(error) }
  }
  if (!isMapping(parsed)) {
    return { ok: false, error: 'The file must be a YAML mapping.' }
  }
  if (isBlank(parsed.name)) {
    return { ok: false, error: 'name is required.' }
  }
  if (isBlank(parsed.model)) {
    return { ok: false, error: 'model is required.' }
  }
  return { ok: true, doc: parsed }
}

/** Les métadonnées d'un document : absentes ou `null`, elles valent un objet vide. */
const metadataOf = (value: unknown): Record<string, unknown> => (isMapping(value) ? value : {})

/**
 * `metadata` se met à jour par patch (« Omitted keys are preserved ») : seules les clés ajoutées ou modifiées
 * partent, et une clé retirée part à `null`. Un patch vide ne part pas.
 */
function metadataPatch(before: unknown, after: unknown): Record<string, unknown> | null {
  const previous = metadataOf(before)
  const next = metadataOf(after)
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(next)) {
    if (!isDeepStrictEqual(previous[key], next[key])) {
      patch[key] = next[key]
    }
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) {
      patch[key] = null
    }
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Les clés de premier niveau de `after` qui diffèrent de `before` (égalité profonde), valeur entière. Une clé
 * retirée part à `null`, sauf `metadata`, qui part en patch. Une valeur de `metadata` qui n'est pas un objet
 * (une erreur de frappe) part telle quelle : l'API la refuse en clair.
 */
export function changedTopLevel(before: AgentDocument, after: AgentDocument): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(after)) {
    if (key === 'metadata') {
      continue
    }
    if (!isDeepStrictEqual(before[key], after[key])) {
      changed[key] = after[key]
    }
  }
  for (const key of Object.keys(before)) {
    if (key !== 'metadata' && !(key in after)) {
      changed[key] = null
    }
  }
  const raw = after.metadata
  if (raw !== undefined && raw !== null && !isMapping(raw)) {
    if (!isDeepStrictEqual(before.metadata, raw)) {
      changed.metadata = raw
    }
  } else {
    const patch = metadataPatch(before.metadata, raw)
    if (patch !== null) {
      changed.metadata = patch
    }
  }
  return changed
}

/** La copie exacte de la vue « Brut » d'un agent vierge dans la console (relevée le 22/11). */
export const NEW_AGENT_YAML = `name: Untitled agent
description: A blank starting point with the core toolset.
model:
  id: claude-opus-5-5
  effort: low
system: You are a general-purpose agent that can research, write code, run commands, and use connected tools to complete the user's task end to end.
mcp_servers: []
tools:
  - type: agent_toolset_20260401
    default_config:
      permission_policy:
        type: auto
skills: []
`
