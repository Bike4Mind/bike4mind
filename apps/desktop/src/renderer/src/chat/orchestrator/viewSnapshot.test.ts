// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { acceptViewAction, viewSnapshotSchema } from '@shared/viewSnapshot';
import { agentFixture } from './testUtils';
import { toViewSnapshot } from './viewSnapshot';
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
    expect(waiting.agents[0].decision).toEqual({ id: 'd1', question: 'Which database?' });
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

describe('acceptViewAction', () => {
  const snapshot = toViewSnapshot('root', [agentFixture('a')], {});

  it('accepts well-formed actions on listed agents', () => {
    expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'a' })).toEqual({
      kind: 'open-agent',
      agentId: 'a',
    });
    expect(acceptViewAction(snapshot, { kind: 'open-root' })).toEqual({ kind: 'open-root' });
  });

  it('rejects unknown agents, unknown kinds and extra fields', () => {
    expect(acceptViewAction(snapshot, { kind: 'open-agent', agentId: 'someone-else' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'send-message', agentId: 'a', text: 'hi' })).toBeUndefined();
    expect(acceptViewAction(snapshot, { kind: 'open-root', extra: true })).toBeUndefined();
    expect(acceptViewAction(snapshot, null)).toBeUndefined();
  });
});
