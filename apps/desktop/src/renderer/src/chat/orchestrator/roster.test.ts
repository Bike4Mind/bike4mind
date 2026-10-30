import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import type { ChildOutcome } from '@shared/agentOutcome';
import { describe, expect, it } from 'vitest';
import type { AgentActivity } from './activity';
import {
  AGENT_STATE_LABEL,
  AGENT_STATE_PRIORITY,
  buildRoster,
  agentStates,
  deriveAgentState,
  descendantIds,
  formatAgentCost,
  summarizeRoster,
  type AgentState,
  type AgentView,
} from './roster';

const summary = (
  id: string,
  parentId: string | undefined,
  overrides: Partial<ChatSessionSummary> = {}
): ChatSessionSummary =>
  ({
    id,
    title: `Title ${id}`,
    model: 'm',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mode: 'code',
    approvalMode: 'ask',
    reasoningEffort: 'medium',
    messageCount: 1,
    ...(parentId ? { origin: { parentSessionId: parentId, depth: 1, seedPrompt: `seed ${id}` } } : {}),
    ...overrides,
  }) as ChatSessionSummary;

const noInput = {
  statuses: new Map<string, ChatSessionStatus>(),
  activity: new Map<string, AgentActivity>(),
  prSummaries: new Map<string, PrSummary>(),
};

describe('deriveAgentState', () => {
  const outcomes: ReadonlyArray<readonly [ChildOutcome | undefined, AgentState]> = [
    ['finished', 'done'],
    ['max-tokens', 'failed'],
    ['failed', 'failed'],
    ['turn-budget', 'failed'],
    ['context-limit', 'failed'],
    ['aborted', 'stopped'],
    ['no-reply', 'idle'],
    [undefined, 'idle'],
  ];

  it.each(outcomes)('with outcome %s and a settled status is %s', (outcome, expected) => {
    expect(deriveAgentState('done', outcome)).toBe(expected);
    expect(deriveAgentState(undefined, outcome)).toBe(expected);
  });

  it('lets a live status override the stored outcome', () => {
    expect(deriveAgentState('needs-action', 'finished')).toBe('needs-you');
    expect(deriveAgentState('processing', 'failed')).toBe('working');
  });
});

describe('labels and priority', () => {
  it('labels every state and prioritizes every state once', () => {
    expect(AGENT_STATE_LABEL).toEqual({
      'needs-you': 'Needs you',
      working: 'Working',
      done: 'Done',
      failed: 'Failed',
      stopped: 'Stopped',
      idle: 'Idle',
    });
    expect([...AGENT_STATE_PRIORITY].sort()).toEqual(Object.keys(AGENT_STATE_LABEL).sort());
  });
});

describe('buildRoster', () => {
  it('returns children and grandchildren with depth, excluding the root, archived and unrelated sessions', () => {
    const sessions = [
      summary('root', undefined),
      summary('child', 'root'),
      summary('grandchild', 'child'),
      summary('archived', 'root', { archived: true }),
      summary('other-root', undefined),
      summary('other-child', 'other-root'),
    ];
    const roster = buildRoster({ sessions, rootId: 'root', ...noInput });
    const depths = Object.fromEntries(roster.map(agent => [agent.id, agent.depth]));
    expect(depths).toEqual({ child: 1, grandchild: 2 });
  });

  it('terminates on a cycle that never reaches the root', () => {
    const sessions = [summary('root', undefined), summary('a', 'b'), summary('b', 'a')];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput })).toEqual([]);
  });

  it('never lists the root in its own roster, even on a loop through it', () => {
    const sessions = [summary('root', 'a'), summary('a', 'root'), summary('self', 'self')];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput }).map(agent => agent.id)).toEqual(['a']);
    expect(buildRoster({ sessions, rootId: 'self', ...noInput })).toEqual([]);
  });

  it('falls back for a whitespace-only title', () => {
    const sessions = [summary('root', undefined), summary('c', 'root', { title: '   ' })];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput })[0]?.title).toBe('Untitled agent');
  });

  it('leaves out a child whose parent was deleted, for every root', () => {
    const sessions = [summary('root', undefined), summary('orphan', 'deleted'), summary('x', undefined)];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput })).toEqual([]);
    expect(buildRoster({ sessions, rootId: 'x', ...noInput })).toEqual([]);
  });

  it('gives idle after a restart: no statuses, no Task 1 fields', () => {
    const roster = buildRoster({
      sessions: [summary('root', undefined), summary('c', 'root')],
      rootId: 'root',
      ...noInput,
    });
    expect(roster).toHaveLength(1);
    expect(roster[0]?.state).toBe('idle');
    expect(roster[0]?.outcome).toBeUndefined();
  });

  it('maps summary fields, branch and pr onto the view', () => {
    const pr = { number: 7 } as unknown as PrSummary;
    const sessions = [
      summary('root', undefined),
      summary('a', 'root', {
        title: '',
        model: 'opus',
        lastOutcome: 'finished',
        lastSnippet: 'all done',
        totalUsdCost: 0.5,
        totalCredits: 20,
        project: { branch: 'main', workspaceBranch: 'agent/a' } as ChatSessionSummary['project'],
      }),
      summary('b', 'root', { project: { branch: 'main' } as ChatSessionSummary['project'] }),
    ];
    const roster = buildRoster({
      sessions,
      rootId: 'root',
      ...noInput,
      prSummaries: new Map([['a', pr]]),
    });
    const a = roster.find(agent => agent.id === 'a');
    expect(a).toMatchObject({
      title: 'Untitled agent',
      parentId: 'root',
      seedPrompt: 'seed a',
      model: 'opus',
      state: 'done',
      outcome: 'finished',
      lastSnippet: 'all done',
      usdCost: 0.5,
      credits: 20,
      pr,
      branch: 'agent/a',
    });
    expect(roster.find(agent => agent.id === 'b')?.branch).toBe('main');
  });

  it('attaches activity only to a working agent', () => {
    const activity = new Map<string, AgentActivity>([
      ['busy', { kind: 'phase', phase: 'thinking' }],
      ['calm', { kind: 'phase', phase: 'thinking' }],
    ]);
    const roster = buildRoster({
      sessions: [summary('root', undefined), summary('busy', 'root'), summary('calm', 'root')],
      rootId: 'root',
      statuses: new Map<string, ChatSessionStatus>([['busy', 'processing']]),
      activity,
      prSummaries: new Map(),
    });
    expect(roster.find(agent => agent.id === 'busy')?.activity).toEqual({ kind: 'phase', phase: 'thinking' });
    expect(roster.find(agent => agent.id === 'calm')?.activity).toBeUndefined();
  });

  it('leaves out an agent below an archived ancestor', () => {
    const sessions = [
      summary('root', undefined),
      summary('shelved', 'root', { archived: true }),
      summary('under-shelved', 'shelved'),
      summary('deeper', 'under-shelved'),
      summary('kept', 'root'),
    ];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput }).map(agent => agent.id)).toEqual(['kept']);
  });

  it('keeps the roster of an archived root', () => {
    const sessions = [summary('root', undefined, { archived: true }), summary('child', 'root')];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput }).map(agent => agent.id)).toEqual(['child']);
  });

  it('sorts by state priority, then newest first', () => {
    const sessions = [
      summary('root', undefined),
      summary('done-old', 'root', { lastOutcome: 'finished', createdAt: '2026-01-01T00:00:00.000Z' }),
      summary('idle-new', 'root', { createdAt: '2026-01-05T00:00:00.000Z' }),
      summary('needs', 'root', { createdAt: '2026-01-02T00:00:00.000Z' }),
      summary('working-new', 'root', { createdAt: '2026-01-04T00:00:00.000Z' }),
      summary('working-old', 'root', { createdAt: '2026-01-03T00:00:00.000Z' }),
    ];
    const roster = buildRoster({
      sessions,
      rootId: 'root',
      statuses: new Map<string, ChatSessionStatus>([
        ['needs', 'needs-action'],
        ['working-new', 'processing'],
        ['working-old', 'processing'],
      ]),
      activity: new Map(),
      prSummaries: new Map(),
    });
    expect(roster.map(agent => agent.id)).toEqual(['needs', 'working-new', 'working-old', 'idle-new', 'done-old']);
  });
});

describe('descendantIds', () => {
  it('lists the ids buildRoster would, and nothing for a null root', () => {
    const sessions = [
      summary('root', undefined),
      summary('child', 'root'),
      summary('grand', 'child'),
      summary('archived', 'root', { archived: true }),
      summary('other', undefined),
    ];
    expect([...descendantIds(sessions, 'root')].sort()).toEqual(['child', 'grand']);
    expect(descendantIds(sessions, null).size).toBe(0);
  });
});

describe('agentStates', () => {
  it('derives each agent state from statuses alone, empty for a null root', () => {
    const sessions = [
      summary('root', undefined),
      summary('a', 'root', { lastOutcome: 'finished' }),
      summary('b', 'root'),
      summary('c', 'a'),
    ];
    const statuses = new Map<string, ChatSessionStatus>([
      ['b', 'processing'],
      ['c', 'needs-action'],
    ]);
    expect(agentStates(sessions, statuses, 'root').sort()).toEqual(['done', 'needs-you', 'working']);
    expect(agentStates(sessions, statuses, null)).toEqual([]);
  });
});

describe('summarizeRoster', () => {
  const view = (state: AgentState, usdCost?: number, credits?: number): AgentView => ({
    id: state,
    title: state,
    parentId: 'root',
    depth: 1,
    seedPrompt: '',
    createdAt: '',
    updatedAt: '',
    model: 'm',
    state,
    usdCost,
    credits,
  });

  it('counts states and totals cost, flagging an agent with no cost as partial', () => {
    const result = summarizeRoster([
      view('working', 0.25, 10),
      view('done', 0.5),
      view('done', undefined, 5),
      view('idle'),
    ]);
    expect(result.total).toBe(4);
    expect(result.counts).toEqual({ 'needs-you': 0, working: 1, done: 2, failed: 0, stopped: 0, idle: 1 });
    expect(result.usdCost).toBeCloseTo(0.75);
    expect(result.credits).toBe(15);
    expect(result.costPartial).toBe(true);
  });

  it('is not partial when every agent reported the shown currency', () => {
    expect(summarizeRoster([view('done', 1), view('done', 2, 3)]).costPartial).toBe(false);
    expect(summarizeRoster([view('done', undefined, 1), view('done', undefined, 2)]).costPartial).toBe(false);
    expect(summarizeRoster([]).costPartial).toBe(false);
  });

  it('is partial when a credit-only agent sits beside dollar costs', () => {
    const result = summarizeRoster([view('done', 1), view('done', undefined, 2)]);
    expect(result.hasUsd).toBe(true);
    expect(result.costPartial).toBe(true);
  });

  it('reports credits only when no agent has a dollar cost', () => {
    expect(summarizeRoster([view('done', undefined, 2)]).hasUsd).toBe(false);
  });
});

describe('formatAgentCost', () => {
  it('prefers dollars, then credits, then a dash', () => {
    expect(formatAgentCost(0.4213)).toBe('$0.42');
    expect(formatAgentCost(0.4213, 12)).toBe('$0.42');
    expect(formatAgentCost(undefined, 12)).toBe('12 cr');
    expect(formatAgentCost()).toBe('-');
  });
});
