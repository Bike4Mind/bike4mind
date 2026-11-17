// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptViewAction, viewSnapshotSchema, type ViewApproval } from '@shared/viewSnapshot';
import { agentFixture } from './testUtils';
import { runViewAction, toViewSnapshot } from './viewSnapshot';
import type { AgentView } from './roster';

const decision: NonNullable<AgentView['decision']> = {
  id: 'd1',
  askedAt: '2026-10-01T00:00:00.000Z',
  question: {
    question: 'Which database?',
    header: 'Decision',
    options: [
      { label: 'Postgres (Recommended)', description: 'Relational' },
      { label: 'Mongo', description: 'Documents' },
    ],
  },
};

describe('toViewSnapshot', () => {
  it('maps every agent state and keeps the roster order', () => {
    const agents = (['needs-you', 'working', 'failed', 'stopped', 'idle', 'done'] as const).map(state =>
      agentFixture(state, state)
    );
    const snapshot = toViewSnapshot('root', agents, {});
    expect(viewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.agents.map(agent => agent.state)).toEqual([
      'needs-you',
      'working',
      'failed',
      'stopped',
      'idle',
      'done',
    ]);
  });

  it('derives the root state from its session status', () => {
    expect(toViewSnapshot('root', [], { status: 'needs-action' }).root.state).toBe('needs-you');
    expect(toViewSnapshot('root', [], { status: 'processing' }).root.state).toBe('working');
    expect(toViewSnapshot('root', [], { status: 'done' }).root.state).toBe('idle');
    expect(toViewSnapshot('root', [], {}).root.state).toBe('idle');
  });

  it('carries a pending decision only while the agent needs the user', () => {
    const waiting = toViewSnapshot('root', [agentFixture('a', 'needs-you', { decision })], {});
    expect(waiting.agents[0].decision).toEqual({
      id: 'd1',
      question: 'Which database?',
      options: ['Postgres (Recommended)', 'Mongo'],
    });
    const multi = { ...decision, question: { ...decision.question, multiSelect: true } };
    const many = toViewSnapshot('root', [agentFixture('a', 'needs-you', { decision: multi })], {});
    expect(many.agents[0].decision?.multiSelect).toBe(true);
    const moved = toViewSnapshot('root', [agentFixture('a', 'working', { decision })], {});
    expect(moved.agents[0].decision).toBeUndefined();
  });

  it('passes display fields and leaves out prompts and models', () => {
    const agent = agentFixture('a', 'done', {
      lastSnippet: 'Opened the PR',
      pr: { number: 12, state: 'open' },
      credits: 3,
      branch: 'feat/x',
    });
    const [view] = toViewSnapshot('root', [agent], {}).agents;
    expect(view).toMatchObject({ now: 'Opened the PR', pr: { number: 12, state: 'open' }, credits: 3 });
    expect(view).not.toHaveProperty('seedPrompt');
    expect(view).not.toHaveProperty('model');
    expect(view).not.toHaveProperty('branch');
  });
});

it('lists quick approvals only for the root and agents on the roster', () => {
  const approvals: ViewApproval[] = [
    { id: 'p-root', sessionId: 'root', label: 'bash pnpm test' },
    { id: 'p-a', sessionId: 'a', label: 'bash ls' },
    { id: 'p-gone', sessionId: 'not-listed', label: 'bash ls' },
  ];
  const snapshot = toViewSnapshot('root', [agentFixture('a', 'needs-you')], {}, approvals);
  expect(viewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  expect(snapshot.approvals?.map(approval => approval.id)).toEqual(['p-root', 'p-a']);
  expect(toViewSnapshot('root', [], {})).not.toHaveProperty('approvals');
});

describe('acceptViewAction', () => {
  const snapshot = toViewSnapshot(
    'root',
    [
      agentFixture('ask', 'needs-you', { decision }),
      agentFixture('gate', 'needs-you'),
      agentFixture('busy', 'working'),
      agentFixture('over', 'done'),
      agentFixture('stale', 'working', { decision }),
    ],
    { status: 'needs-action' },
    [
      { id: 'p1', sessionId: 'gate', label: 'bash pnpm test' },
      { id: 'p-root', sessionId: 'root', label: 'bash ls' },
    ]
  );
  const answered = (selected: string[], other?: string) => ({
    status: 'answered',
    answers: [{ selected, ...(other !== undefined && { other }) }],
  });
  const answer = (value: unknown, agentId = 'ask', decisionId = 'd1') => ({
    kind: 'answer',
    agentId,
    decisionId,
    answer: value,
  });

  it('accepts opening a listed agent or the root', () => {
    expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'over' })).toEqual({
      kind: 'open-agent',
      agentId: 'over',
    });
    expect(acceptViewAction(snapshot, { kind: 'open-root' })).toEqual({ kind: 'open-root' });
  });

  it('accepts an option of the pending decision, typed text, or a skip', () => {
    expect(acceptViewAction(snapshot, answer(answered(['Mongo'])))).toEqual(answer(answered(['Mongo'])));
    expect(acceptViewAction(snapshot, answer(answered([], '  SQLite  ')))).toEqual(answer(answered([], 'SQLite')));
    expect(acceptViewAction(snapshot, answer({ status: 'skipped' }))).toEqual(answer({ status: 'skipped' }));
  });

  it('rejects an answer that does not fit the pending decision', () => {
    const rejected = [
      answer(answered(['Oracle'])),
      answer(answered(['Postgres'])),
      answer(answered(['Mongo', 'Postgres (Recommended)'])),
      answer(answered(['Mongo', 'Mongo'])),
      answer(answered(['Mongo'], 'and also this')),
      answer(answered([])),
      answer(answered([], '   ')),
      answer({ status: 'answered', answers: [] }),
      answer({ status: 'answered', answers: [{ selected: ['Mongo'] }, { selected: ['Mongo'] }] }),
      answer({ status: 'answered', answers: [{ selected: ['Mongo'], extra: 1 }] }),
      answer({ status: 'cancelled' }),
      { ...answer(answered(['Mongo'])), extra: true },
    ];
    for (const action of rejected) expect(acceptViewAction(snapshot, action)).toBeUndefined();
  });

  it('rejects an answer to a decision that is not pending on that agent', () => {
    expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'ask', 'd-old'))).toBeUndefined();
    expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'gate'))).toBeUndefined();
    expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'stale'))).toBeUndefined();
    expect(acceptViewAction(snapshot, answer(answered(['Mongo']), 'someone-else'))).toBeUndefined();
  });

  it('allows several picks only on a multi-select decision', () => {
    const multi = { ...decision, question: { ...decision.question, multiSelect: true } };
    const many = toViewSnapshot('root', [agentFixture('ask', 'needs-you', { decision: multi })], {});
    const both = answer(answered(['Mongo', 'Postgres (Recommended)']));
    expect(acceptViewAction(many, both)).toEqual(both);
    const withText = answer(answered(['Mongo'], 'plus Redis'));
    expect(acceptViewAction(many, withText)).toEqual(withText);
  });

  it('accepts allow once or deny on a listed quick approval', () => {
    for (const mode of ['once', 'deny'] as const) {
      expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode })).toEqual({
        kind: 'approve',
        approvalId: 'p1',
        mode,
      });
    }
    expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p-root', mode: 'once' })).toBeDefined();
  });

  it('rejects approvals that are not listed as quick, and any other mode', () => {
    expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p-full-card', mode: 'once' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'always' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'redirect' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'approve', approvalId: 'p1', mode: 'once', value: 'x' })).toBeUndefined();
    const none = toViewSnapshot('root', [agentFixture('gate', 'needs-you')], {});
    expect(acceptViewAction(none, { kind: 'approve', approvalId: 'p1', mode: 'once' })).toBeUndefined();
  });

  it('accepts Stop on a working or waiting agent only', () => {
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'busy' })).toEqual({ kind: 'stop', agentId: 'busy' });
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'ask' })).toBeDefined();
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'over' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'root' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'someone-else' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'stop', agentId: 'busy', force: true })).toBeUndefined();
  });

  it('rejects unknown agents, unknown kinds and extra fields', () => {
    expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'someone-else' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'send-message', agentId: 'ask', text: 'hi' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'open-root', extra: true })).toBeUndefined();
    expect(acceptViewAction(snapshot, null)).toBeUndefined();
  });
});

describe('runViewAction', () => {
  const chat = { answerTaskDecision: vi.fn(async () => undefined), respondToApproval: vi.fn(async () => undefined) };
  const host = { openAgent: vi.fn(), openRoot: vi.fn(), stop: vi.fn() };
  (window as unknown as { b4m: unknown }).b4m = { chat };

  afterEach(() => {
    for (const mock of [...Object.values(chat), ...Object.values(host)]) mock.mockClear();
  });

  it('answers through the decision card call', async () => {
    const value = { status: 'answered' as const, answers: [{ selected: ['Mongo'] }] };
    await runViewAction({ kind: 'answer', agentId: 'ask', decisionId: 'd1', answer: value }, host);
    expect(chat.answerTaskDecision).toHaveBeenCalledWith('ask', 'd1', value);
  });

  it('approves through the approval card call, never with more than the decision', async () => {
    await runViewAction({ kind: 'approve', approvalId: 'p1', mode: 'deny' }, host);
    expect(chat.respondToApproval).toHaveBeenCalledWith('p1', { decision: 'deny' });
  });

  it('opens and stops through the host', async () => {
    await runViewAction({ kind: 'open-agent', agentId: 'a' }, host);
    await runViewAction({ kind: 'open-root' }, host);
    await runViewAction({ kind: 'stop', agentId: 'busy' }, host);
    expect(host.openAgent).toHaveBeenCalledWith('a');
    expect(host.openRoot).toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledWith('busy');
  });

  it('passes on a refusal from main', async () => {
    chat.respondToApproval.mockRejectedValueOnce(new Error('Already answered'));
    await expect(runViewAction({ kind: 'approve', approvalId: 'p1', mode: 'once' }, host)).rejects.toThrow(
      'Already answered'
    );
  });
});
