import { describe, expect, it } from 'vitest';
import type { LocalLoopDetail, LocalRun, LocalTicket } from '@shared/localLoops';
import { buildLoopRoster, isLoopSessionId } from './roster';

const ticket = (patch: Partial<LocalTicket>): LocalTicket => ({
  id: 't1',
  loopId: 'l1',
  title: 'Fix the docs',
  stage: 'todo',
  status: 'open',
  dependencies: [],
  runCount: 0,
  stageHistory: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...patch,
});

const run = (patch: Partial<LocalRun>): LocalRun => ({
  id: 'r1',
  loopId: 'l1',
  kind: 'ticket',
  model: 'run-model',
  fallback: false,
  startedAt: '2026-01-02T00:00:00.000Z',
  credits: 12,
  ...patch,
});

const detail = (patch: Partial<LocalLoopDetail> & { maxConcurrent?: number }): LocalLoopDetail => ({
  loop: {
    id: 'l1',
    name: 'Docs',
    goal: '',
    stages: ['todo'],
    stageConfig: [],
    model: 'loop-model',
    maxConcurrent: patch.maxConcurrent ?? 3,
    status: 'live',
    directory: '/repo',
    approvalMode: 'auto',
    mirror: true,
    memory: { notes: '', nextAction: '' },
    errorStreak: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  lanesBusy: 0,
  spentToday: 0,
  needsYou: 0,
  tickets: [],
  runs: [],
  events: [],
  ...patch,
});

describe('buildLoopRoster', () => {
  it('shows a running run as a working agent on its session, with its credits and model', () => {
    const roster = buildLoopRoster(
      detail({
        tickets: [ticket({ status: 'in_progress' })],
        runs: [run({ ticketId: 't1', sessionId: 's1' }), run({ id: 'r0', ticketId: 't1', endedAt: 'x' })],
      })
    );
    expect(roster[0]).toMatchObject({
      id: 's1',
      title: 'Fix the docs',
      state: 'working',
      credits: 12,
      model: 'run-model',
    });
    expect(isLoopSessionId(roster[0].id)).toBe(true);
  });

  it('titles a triage run Triage and gives a run with no session yet a synthetic id', () => {
    const [agent] = buildLoopRoster(detail({ runs: [run({ kind: 'triage' })], maxConcurrent: 1 }));
    expect(agent).toMatchObject({ id: 'run:r1', title: 'Triage', state: 'working' });
    expect(isLoopSessionId(agent.id)).toBe(false);
  });

  it('shows an asked or unsure ticket as needing you, on its last session', () => {
    const roster = buildLoopRoster(
      detail({
        tickets: [ticket({ status: 'blocked', statusReason: 'UNSURE: which page?' })],
        runs: [run({ ticketId: 't1', sessionId: 's9', endedAt: 'x' })],
        maxConcurrent: 1,
      })
    );
    expect(roster[0]).toMatchObject({ id: 's9', state: 'needs-you', lastSnippet: 'UNSURE: which page?' });
  });

  it('fills the free lanes with resting agents that carry the idle reason', () => {
    const roster = buildLoopRoster(
      detail({ runs: [run({ sessionId: 's1', ticketId: 't1' })], idleReason: 'capped until 09:00' })
    );
    expect(roster.map(agent => agent.state)).toEqual(['working', 'idle', 'idle']);
    expect(roster.slice(1).map(agent => agent.title)).toEqual(['Lane 2', 'Lane 3']);
    expect(roster[1].lastSnippet).toBe('capped until 09:00');
  });

  it('shows every lane resting on a paused loop with no runs', () => {
    const roster = buildLoopRoster(detail({ idleReason: 'paused', maxConcurrent: 2 }));
    expect(roster).toHaveLength(2);
    expect(roster.every(agent => agent.state === 'idle' && agent.lastSnippet === 'paused')).toBe(true);
  });
});
