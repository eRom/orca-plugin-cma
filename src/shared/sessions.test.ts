import { assert, test } from 'orca/testing'
import type { SessionBadge, SessionRow } from '../protocol'
import { badgeLabel, badgeTone, sortSessions, statusBarText } from './sessions'

function row(id: string, badge: SessionBadge, updatedAt: number, pendingApprovals = 0, title: string | null = null): SessionRow {
  return {
    id,
    title,
    agentId: 'agent_1',
    agentName: 'Agent',
    status: badge === 'terminated' ? 'terminated' : badge === 'idle' ? 'idle' : 'running',
    badge,
    cost: null,
    budget: null,
    updatedAt: new Date(updatedAt * 1000).toISOString(),
    pendingApprovals,
  }
}

test('sortSessions ranks needs_approval, then running, then the rest, newest first in each rank', () => {
  const sorted = sortSessions([
    row('idle3', 'idle', 3),
    row('running1', 'running', 1),
    row('approval0', 'needs_approval', 0),
    row('terminated5', 'terminated', 5),
    row('running4', 'running', 4),
  ])
  assert.deepEqual(
    sorted.map((r) => r.id),
    ['approval0', 'running4', 'running1', 'terminated5', 'idle3'],
  )
})

test('sortSessions does not mutate its input', () => {
  const input = [row('a', 'idle', 1), row('b', 'needs_approval', 0)]
  sortSessions(input)
  assert.deepEqual(input.map((r) => r.id), ['a', 'b'])
})

test('badgeLabel and badgeTone cover every badge', () => {
  const expected: [SessionBadge, string, string][] = [
    ['needs_approval', 'Needs approval', 'warning'],
    ['blocked', 'Blocked', 'danger'],
    ['budget_reached', 'Budget reached', 'danger'],
    ['running', 'Running', 'accent'],
    ['rescheduling', 'Rescheduling', 'neutral'],
    ['idle', 'Idle', 'neutral'],
    ['terminated', 'Terminated', 'neutral'],
  ]
  for (const [badge, label, tone] of expected) {
    assert.equal(badgeLabel(badge), label, badge)
    assert.equal(badgeTone(badge), tone, badge)
  }
})

test('statusBarText says Managed Agents alone when nothing runs and nothing waits', () => {
  const result = statusBarText([row('a', 'idle', 1), row('b', 'blocked', 2, 1)])
  assert.equal(result.text, 'Managed Agents')
  assert.equal(result.tone, 'neutral')
  assert.equal(result.tooltip, 'Managed Agents')
})

test('statusBarText counts running sessions only, and lists their titles in the tooltip', () => {
  const result = statusBarText([row('a', 'running', 1, 0, 'Triage'), row('b', 'running', 2), row('c', 'idle', 3), row('d', 'rescheduling', 4)])
  assert.equal(result.text, 'Managed Agents · 2 running')
  assert.equal(result.tone, 'neutral')
  assert.equal(result.tooltip, 'Triage\nb')
})

test('statusBarText sums approvals over needs_approval sessions and lists their titles', () => {
  const result = statusBarText([
    row('a', 'needs_approval', 1, 1, 'Deploy bot'),
    row('b', 'needs_approval', 2, 1, 'Triage inbox'),
    row('c', 'running', 3),
  ])
  assert.equal(result.text, '2 approvals')
  assert.equal(result.tone, 'warning')
  assert.ok(result.tooltip.includes('Deploy bot'))
  assert.ok(result.tooltip.includes('Triage inbox'))
})

test('statusBarText uses the singular for one approval', () => {
  assert.equal(statusBarText([row('a', 'needs_approval', 1, 1, 'Solo')]).text, '1 approval')
})

test('statusBarText falls back to the session id when the title is missing', () => {
  const result = statusBarText([row('sesn_untitled', 'needs_approval', 1, 1)])
  assert.ok(result.tooltip.includes('sesn_untitled'))
})
