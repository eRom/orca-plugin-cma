import type { Tone } from 'orca'
import type { SessionBadge, SessionRow } from '../protocol'

const BADGE_LABELS: Record<SessionBadge, string> = {
  needs_approval: 'Needs approval',
  blocked: 'Blocked',
  budget_reached: 'Budget reached',
  running: 'Running',
  rescheduling: 'Rescheduling',
  idle: 'Idle',
  terminated: 'Terminated',
}

const BADGE_TONES: Record<SessionBadge, Tone> = {
  needs_approval: 'warning',
  blocked: 'danger',
  budget_reached: 'danger',
  running: 'accent',
  rescheduling: 'neutral',
  idle: 'neutral',
  terminated: 'neutral',
}

export function badgeLabel(badge: SessionBadge): string {
  return BADGE_LABELS[badge]
}

export function badgeTone(badge: SessionBadge): Tone {
  return BADGE_TONES[badge]
}

/** Rang de tri : les accords en attente d'abord, puis les sessions en cours, puis le reste. */
function rank(badge: SessionBadge): number {
  if (badge === 'needs_approval') return 0
  if (badge === 'running') return 1
  return 2
}

/** Tri de la liste des sessions : par rang, puis `updatedAt` décroissant. N'altère pas l'entrée. */
export function sortSessions(rows: readonly SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => {
    const byRank = rank(a.badge) - rank(b.badge)
    if (byRank !== 0) return byRank
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

const BAR_NAME = 'Managed Agents'

/**
 * Texte de la barre d'état : le nombre d'accords en attente (prioritaire), sinon « Managed Agents » suivi du nombre de
 * sessions au badge `running` s'il y en a.
 */
export function statusBarText(rows: readonly SessionRow[]): { text: string; tone: 'warning' | 'neutral'; tooltip: string } {
  const waiting = rows.filter((row) => row.badge === 'needs_approval')
  if (waiting.length === 0) {
    const running = rows.filter((row) => row.badge === 'running')
    if (running.length === 0) return { text: BAR_NAME, tone: 'neutral', tooltip: 'Managed Agents' }
    return { text: `${BAR_NAME} · ${running.length} running`, tone: 'neutral', tooltip: running.map((row) => row.title ?? row.id).join('\n') }
  }
  const approvals = waiting.reduce((total, row) => total + row.pendingApprovals, 0)
  const tooltip = waiting.map((row) => row.title ?? row.id).join('\n')
  return { text: `${approvals} ${approvals === 1 ? 'approval' : 'approvals'}`, tone: 'warning', tooltip }
}
