import { describe, expect, it } from 'vitest';
import type {
  ChatSessionStatus,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
  SessionSetupStep,
} from '@shared/chat';
import type { PrSummary } from '@shared/pullRequest';
import type { ChildOutcome } from '@shared/agentOutcome';
import { assignPersonas } from '@shared/agentPersona';
import { needsYouTitle, needsYouCount } from '@shared/needsYou';
import { type AgentActivity, activityLabel, agentNowText, foldActivity, toolKind, type ToolKind } from './activity';
import {
  AGENT_STATE_LABEL,
  AGENT_STATE_PRIORITY,
  buildRoster,
  agentStates,
  deriveAgentState,
  descendantIds,
  formatAgentCost,
  formatRosterCost,
  spawnerName,
  summarizeRoster,
  type AgentState,
  type AgentView,
} from './roster';
import { countAgentStates, describeAgentStates } from '@shared/agentState';
import type { WorkerTask } from '@shared/orchestration';
import { buildWatchSnapshot } from '@shared/watch';
import { needsYouTitle as trayNeedsYouTitle, trayPresentation } from '../../../../main/watch/trayPresentation';
import { miniStripLabel } from '../../watch/MiniStrip';
import type { CompletionRunUsage } from '@bike4mind/common';
import type { RunSpend } from '@shared/runSpend';
import { describeRunSpend, formatCheckedAt } from './runSpend';
import { describeToolInput } from '@shared/toolDetail';

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
    ['max-tokens', 'done'],
    ['failed', 'failed'],
    ['turn-budget', 'paused'],
    ['context-limit', 'stopped'],
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

  it('calls a settled agent with running background jobs waiting, below a live status', () => {
    const jobs = { running: 1, label: 'pnpm test' };
    expect(deriveAgentState('done', 'finished', jobs)).toBe('waiting');
    expect(deriveAgentState(undefined, 'turn-budget', jobs)).toBe('waiting');
    expect(deriveAgentState('processing', 'finished', jobs)).toBe('working');
    expect(deriveAgentState('needs-action', 'finished', jobs)).toBe('needs-you');
    expect(deriveAgentState('done', 'finished', { running: 0, label: 'x' })).toBe('done');
  });
});

describe('labels and priority', () => {
  it('labels every state and prioritizes every state once', () => {
    expect(AGENT_STATE_LABEL).toEqual({
      'needs-you': 'Needs you',
      working: 'Working',
      waiting: 'Waiting',
      done: 'Done',
      failed: 'Failed',
      paused: 'Paused',
      stopped: 'Stopped',
      idle: 'Idle',
    });
    expect([...AGENT_STATE_PRIORITY].sort()).toEqual(Object.keys(AGENT_STATE_LABEL).sort());
  });
});

describe('buildRoster', () => {
  it('flags preparing only on a working agent in the preparing set', () => {
    const sessions = [summary('root', undefined), summary('a', 'root'), summary('b', 'root'), summary('c', 'root')];
    const statuses = new Map<string, ChatSessionStatus>([
      ['a', 'processing'],
      ['b', 'processing'],
    ]);
    const roster = buildRoster({
      sessions,
      rootId: 'root',
      ...noInput,
      statuses,
      preparing: new Map([
        ['a', 'starting'],
        ['c', 'worktree'],
      ]),
    });
    const byId = Object.fromEntries(roster.map(agent => [agent.id, agent]));

    expect(byId.a).toMatchObject({ state: 'working', preparing: 'starting' });
    expect(byId.b.preparing).toBeUndefined();
    expect(byId.c.preparing).toBeUndefined();
  });

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

  it('leaves out a side chat, which is not an agent', () => {
    const sessions = [
      summary('root', undefined),
      summary('child', 'root'),
      summary('side-chat', 'root', {
        origin: { parentSessionId: 'root', depth: 1, seedPrompt: 'passage', kind: 'side-chat' },
      }),
    ];
    expect(buildRoster({ sessions, rootId: 'root', ...noInput }).map(agent => agent.id)).toEqual(['child']);
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
        plan: { done: 1, total: 2, next: 'Two' },
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
      plan: { done: 1, total: 2, next: 'Two' },
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

  it('attaches activity only to a working or needs-you agent', () => {
    const activity = new Map<string, AgentActivity>([
      ['busy', { kind: 'phase', phase: 'thinking' }],
      ['calm', { kind: 'phase', phase: 'thinking' }],
      ['asking', { kind: 'phase', phase: 'thinking' }],
    ]);
    const roster = buildRoster({
      sessions: [
        summary('root', undefined),
        summary('busy', 'root'),
        summary('calm', 'root'),
        summary('asking', 'root'),
      ],
      rootId: 'root',
      statuses: new Map<string, ChatSessionStatus>([
        ['busy', 'processing'],
        ['asking', 'needs-action'],
      ]),
      activity,
      prSummaries: new Map(),
    });
    expect(roster.find(agent => agent.id === 'busy')?.activity).toEqual({ kind: 'phase', phase: 'thinking' });
    expect(roster.find(agent => agent.id === 'asking')?.activity).toEqual({ kind: 'phase', phase: 'thinking' });
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

  it('reports no cost, and nothing partial, before any agent has a cost', () => {
    const result = summarizeRoster([view('working'), view('idle')]);
    expect(result.hasCost).toBe(false);
    expect(result.costPartial).toBe(false);
  });

  it('counts states and totals cost, flagging an agent with no cost as partial', () => {
    const result = summarizeRoster([
      view('working', 0.25, 10),
      view('done', 0.5),
      view('done', undefined, 5),
      view('idle'),
    ]);
    expect(result.total).toBe(4);
    expect(result.counts).toEqual({
      total: 4,
      'needs-you': 0,
      working: 1,
      waiting: 0,
      done: 2,
      failed: 0,
      paused: 0,
      stopped: 0,
      idle: 1,
    });
    expect(result.usdCost).toBeCloseTo(0.75);
    expect(result.credits).toBe(15);
    expect(result.costPartial).toBe(true);
  });

  it('is not partial when every agent reported the shown currency', () => {
    expect(summarizeRoster([view('done', undefined, 1), view('done', 2, 3)]).costPartial).toBe(false);
    expect(summarizeRoster([view('done', 1), view('done', 2)]).costPartial).toBe(false);
    expect(summarizeRoster([]).costPartial).toBe(false);
  });

  it('is partial when a dollar-only agent sits beside credit costs', () => {
    const result = summarizeRoster([view('done', 1), view('done', undefined, 2)]);
    expect(result.hasCredits).toBe(true);
    expect(result.costPartial).toBe(true);
  });

  it('falls back to dollars only when no agent reported credits', () => {
    expect(summarizeRoster([view('done', 2)]).hasCredits).toBe(false);
  });

  it('formats the total in credits first, marks a floor with ~, and is undefined with no cost', () => {
    expect(formatRosterCost(summarizeRoster([view('done', 1, 1200), view('done', 2, 34)]))).toBe('1,234 credits');
    expect(formatRosterCost(summarizeRoster([view('done', 1), view('done', undefined, 2)]))).toBe('~2 credits');
    expect(formatRosterCost(summarizeRoster([view('done', 0.5), view('done', 0.25)]))).toBe('$0.75');
    expect(formatRosterCost(summarizeRoster([view('done')]))).toBeUndefined();
  });
});

describe('formatAgentCost', () => {
  it('prefers credits, then dollars, then a dash', () => {
    expect(formatAgentCost(0.4213, 12)).toBe('12 credits');
    expect(formatAgentCost(undefined, 1)).toBe('1 credit');
    expect(formatAgentCost(undefined, 0.2)).toBe('<1 credit');
    expect(formatAgentCost(undefined, 0)).toBe('0 credits');
    expect(formatAgentCost(0.4213)).toBe('$0.42');
    expect(formatAgentCost()).toBe('-');
  });
});

describe('spawnerName', () => {
  const view = (id: string, depth: number, parentId: string, title = `Agent ${id}`) =>
    ({ id, depth, parentId, title }) as AgentView;
  const lead = view('lead', 1, 'root', 'Lead the audit');
  const helper = view('helper', 2, 'lead');

  it('names the spawner below the first level only', () => {
    expect(spawnerName(lead, [lead, helper])).toBeUndefined();
    expect(spawnerName(helper, [lead, helper])).toBe('Lead the audit');
    expect(spawnerName(helper, [lead, helper], spawner => `${spawner.id}!`)).toBe('lead!');
  });

  it('gives nothing when the spawner is off the roster', () => {
    expect(spawnerName(helper, [helper])).toBeUndefined();
  });
});

describe('needsYouTitle parity', () => {
  // Main names agents in its notices without a roster; the name must still be the one the stage shows.
  it('names every agent by the persona the roster gives it', () => {
    const sessions = [
      summary('root', undefined),
      summary('a', 'root', { title: 'Review: auth', createdAt: '2026-01-02T00:00:00.000Z' }),
      summary('b', 'root', { title: 'Review: docs' }),
      summary('c', 'a', { title: '  ' }),
    ];
    const roster = buildRoster({
      sessions,
      statuses: new Map(),
      activity: new Map(),
      prSummaries: new Map(),
      rootId: 'root',
    });
    const personas = assignPersonas(roster);
    for (const id of ['a', 'b', 'c']) {
      expect(needsYouTitle(sessions, id, 'root')).toBe(`${personas.get(id)?.label} needs you`);
    }
  });
});

describe('agentCounts', () => {
  const AT = '2026-11-14T10:00:00.000Z';

  function session(
    id: string,
    parentId: string | null,
    extra: { lastOutcome?: ChildOutcome; task?: WorkerTask['state'] } = {}
  ): ChatSessionSummary {
    return {
      id,
      title: `Agent ${id}`,
      createdAt: AT,
      updatedAt: AT,
      messageCount: 1,
      model: 'test-model',
      ...(parentId ? { origin: { parentSessionId: parentId, seedPrompt: 'go' } } : {}),
      ...(extra.lastOutcome && { lastOutcome: extra.lastOutcome }),
      ...(extra.task && { workerTask: { state: extra.task } as WorkerTask }),
    } as ChatSessionSummary;
  }

  // Stored task results do not add attention absent from the sidebar's live status.
  const sessions = [
    session('root', null),
    session('working', 'root'),
    session('asking', 'root'),
    session('finished', 'root', { lastOutcome: 'finished' }),
    session('accepted', 'root', {
      lastOutcome: 'finished',
      task: { status: 'completed', accepted: true } as WorkerTask['state'],
    }),
    session('unreviewed', 'root', {
      lastOutcome: 'finished',
      task: { status: 'completed', accepted: false } as WorkerTask['state'],
    }),
    session('blocked', 'root', { lastOutcome: 'finished', task: { status: 'blocked' } as WorkerTask['state'] }),
    session('failed', 'root', { lastOutcome: 'failed' }),
    session('aborted', 'root', { lastOutcome: 'aborted' }),
    session('idle', 'root', { lastOutcome: 'no-reply' }),
    session('nested', 'working', { lastOutcome: 'finished' }),
  ];
  const statuses = new Map<string, ChatSessionStatus>([
    ['root', 'needs-action'],
    ['working', 'processing'],
    ['asking', 'needs-action'],
  ]);

  describe('agent counts across surfaces', () => {
    it('agree for the same orchestration on the Tavern, the stage strip, the toggle, the menu bar and the mini Tavern', () => {
      const roster = buildRoster({ sessions, statuses, activity: new Map(), prSummaries: new Map(), rootId: 'root' });
      const parent = { status: statuses.get('root') };
      const stage = summarizeRoster(roster, parent).counts;
      const tavern = describeAgentStates(
        roster.map(agent => agent.state),
        1
      );
      const toggle = countAgentStates(agentStates(sessions, statuses, 'root'), 1);

      const snapshot = buildWatchSnapshot({
        sessions,
        statuses,
        activity: new Map(),
        pending: new Map(),
        needsYouSince: new Map(),
        unacknowledgedDone: new Set(),
        now: Date.parse(AT),
      });
      const tray = trayPresentation(snapshot, false);
      const header = tray.items[0];
      const watched = countAgentStates(
        snapshot.orchestrations[0].agents.map(agent => agent.state),
        1
      );

      expect(stage).toEqual({
        total: 10,
        'needs-you': 2,
        working: 1,
        waiting: 0,
        done: 5,
        failed: 1,
        paused: 0,
        stopped: 1,
        idle: 1,
      });
      expect(toggle).toEqual(stage);
      expect(watched).toEqual(stage);
      expect(tavern).toBe('10 agents: 2 need you, 1 working, 1 failed, 1 stopped, 1 idle, 5 done');
      expect(header).toEqual({ kind: 'header', label: tavern });
      expect(miniStripLabel(snapshot.orchestrations[0])).toBe(`Agent root: ${tavern}`);
      // The menu-bar title and the dock badge count by the same rule as every "needs you" above.
      expect(snapshot.needsYouCount).toBe(stage['needs-you']);
      expect(needsYouCount(statuses, sessions)).toBe(stage['needs-you']);
      expect(tray.title).toBe(trayNeedsYouTitle(stage['needs-you']));
    });
  });
});

describe('runSpend', () => {
  const spend = (creditsCharged: number, requests = 1) => ({
    creditsCharged,
    requests,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  function usage(overrides: Partial<CompletionRunUsage> = {}): CompletionRunUsage {
    return {
      runId: 'run-a',
      createdAt: '2026-11-10T00:00:00.000Z',
      settled: spend(30, 6),
      byRole: [
        { ...spend(10, 2), role: 'root' },
        { ...spend(20, 4), role: 'worker' },
      ],
      byPurpose: [
        { ...spend(27, 4), purpose: 'turn' },
        { ...spend(1, 1), purpose: 'title' },
        { ...spend(2, 1), purpose: 'compaction' },
      ],
      byModel: [],
      byAttempt: [
        { ...spend(10, 2), role: 'root' },
        { ...spend(12, 2), role: 'worker', taskId: 'w1', attemptId: 'a1' },
        { ...spend(8, 2), role: 'worker', taskId: 'w2', attemptId: 'a2' },
      ],
      byAttemptTruncated: false,
      ...overrides,
    };
  }

  const settled = (local: number, server = usage()): RunSpend => ({
    status: 'settled',
    runId: 'run-a',
    local: { creditsCharged: local, requests: 4 },
    server,
    checkedAt: '2026-11-10T00:05:00.000Z',
  });

  describe('describeRunSpend', () => {
    it("leads with the server's settled total and breaks it down by role and purpose", () => {
      const view = describeRunSpend(settled(27));
      expect(view?.chip).toBe('30 credits settled');
      expect(view?.lines).toEqual([
        'Root 10 credits \u00b7 Workers 20 credits over 2 attempts',
        'Turns 27 credits \u00b7 Titles 1 credit \u00b7 Summaries 2 credits',
        'Turn charges match what this device recorded',
        `Server total as of ${formatCheckedAt('2026-11-10T00:05:00.000Z')}`,
      ]);
      expect(view?.reconciled).toBe(true);
    });

    it('says how far the turn charges are from what this device recorded', () => {
      const view = describeRunSpend(settled(25));
      expect(view?.reconciled).toBe(false);
      expect(view?.lines).toContain('This device recorded 25 credits of the 27 credits in turn charges');
    });

    it('marks a worker attempt count that the server cut short', () => {
      const view = describeRunSpend(settled(27, usage({ byAttemptTruncated: true })));
      expect(view?.lines[0]).toBe('Root 10 credits \u00b7 Workers 20 credits over 2+ attempts');
    });

    it("falls back to this device's charges, marked as partial, when the server total is unavailable", () => {
      const view = describeRunSpend({
        status: 'unavailable',
        runId: 'run-a',
        local: { creditsCharged: 12, requests: 3 },
        reason: 'offline',
      });
      expect(view).toEqual({
        chip: '~12 credits (this device)',
        lines: ['Server total unavailable; this device can miss helper calls and dropped requests'],
        reconciled: false,
      });
    });

    it('leaves the estimate alone when the server is unavailable and this device recorded nothing', () => {
      expect(
        describeRunSpend({
          status: 'unavailable',
          runId: 'run-a',
          local: { creditsCharged: 0, requests: 0 },
          reason: 'x',
        })
      ).toBeUndefined();
    });

    it('counts each worker as its own attempt', () => {
      const view = describeRunSpend(
        settled(
          27,
          usage({
            byAttempt: [
              { ...spend(5), role: 'worker', taskId: 'w1' },
              { ...spend(5), role: 'worker', taskId: 'w2' },
              { ...spend(10), role: 'worker', taskId: 'w3' },
            ],
          })
        )
      );
      expect(view?.lines[0]).toContain('over 3 attempts');
    });

    it('describes nothing for a run the server never attributed', () => {
      expect(describeRunSpend({ status: 'unattributed' })).toBeUndefined();
      expect(describeRunSpend(undefined)).toBeUndefined();
    });

    it('describes nothing for a value it does not recognise, such as an empty bridge reply', () => {
      expect(describeRunSpend({} as RunSpend)).toBeUndefined();
    });
  });
});

describe('activity', () => {
  const call = (name: string, input: Record<string, unknown> = {}): ChatToolCall => ({
    id: 'call-1',
    name,
    input,
    status: 'running',
  });

  const base = { sessionId: 's1', messageId: 'm1' };

  describe('foldActivity', () => {
    it('walks tool -> waiting -> absent over a tool round and the end of the turn', () => {
      const empty: ReadonlyMap<string, AgentActivity> = new Map();
      const started = foldActivity(empty, {
        type: 'tool-start',
        ...base,
        call: call('file_edit', { path: '/a/b/X.ts' }),
      });
      expect(started.get('s1')).toEqual({ kind: 'tool', tool: 'file_edit', detail: 'X.ts' });

      const ended = foldActivity(started, { type: 'tool-end', ...base, call: call('file_edit') });
      expect(ended.get('s1')).toEqual({ kind: 'phase', phase: 'waiting' });

      const done = foldActivity(ended, { type: 'done', ...base, content: '' });
      expect(done.has('s1')).toBe(false);
    });

    it('carries the session id a session tool targets, and only for those tools', () => {
      const empty: ReadonlyMap<string, AgentActivity> = new Map();
      const reading = foldActivity(empty, {
        type: 'tool-start',
        ...base,
        call: call('session_read', { session_id: 'child-1' }),
      });
      expect(reading.get('s1')).toEqual({ kind: 'tool', tool: 'session_read', detail: '', target: 'child-1' });
      const other = foldActivity(empty, { type: 'tool-start', ...base, call: call('bash', { session_id: 'x' }) });
      expect(other.get('s1')).toEqual({ kind: 'tool', tool: 'bash', detail: '' });
      const retarget = foldActivity(reading, {
        type: 'tool-start',
        ...base,
        call: call('session_read', { session_id: 'child-2' }),
      });
      expect(retarget).not.toBe(reading);
      expect(retarget.get('s1')).toMatchObject({ target: 'child-2' });
    });

    it('drops the entry on error', () => {
      const current = new Map<string, AgentActivity>([['s1', { kind: 'phase', phase: 'thinking' }]]);
      expect(foldActivity(current, { type: 'error', ...base, message: 'boom' }).has('s1')).toBe(false);
    });

    it('maps a phase event, carrying the tool name only for writing-tool', () => {
      const empty: ReadonlyMap<string, AgentActivity> = new Map();
      const thinking = foldActivity(empty, { type: 'phase', ...base, phase: { kind: 'thinking' } });
      expect(thinking.get('s1')).toEqual({ kind: 'phase', phase: 'thinking' });
      const writing = foldActivity(empty, {
        type: 'phase',
        ...base,
        phase: { kind: 'writing-tool', name: 'file_write' },
      });
      expect(writing.get('s1')).toEqual({ kind: 'phase', phase: 'writing-tool', tool: 'file_write' });
    });

    it('returns the identical map for an event it does not track', () => {
      const current = new Map<string, AgentActivity>([['s1', { kind: 'phase', phase: 'thinking' }]]);
      const event: ChatStreamEvent = { type: 'background-output', sessionId: 's1', processId: 'p', text: 'x' } as never;
      expect(foldActivity(current, event)).toBe(current);
    });

    it('returns the identical map for a repeated identical phase', () => {
      const event: ChatStreamEvent = { type: 'phase', ...base, phase: { kind: 'responding' } };
      const first = foldActivity(new Map(), event);
      expect(foldActivity(first, event)).toBe(first);
    });

    it('returns the identical map when done arrives for a session with no entry', () => {
      const current: ReadonlyMap<string, AgentActivity> = new Map();
      expect(foldActivity(current, { type: 'done', ...base, content: '' })).toBe(current);
    });

    it('does not mutate the map it was given', () => {
      const current: ReadonlyMap<string, AgentActivity> = new Map();
      foldActivity(current, { type: 'phase', ...base, phase: { kind: 'thinking' } });
      expect(current.size).toBe(0);
    });
  });

  describe('describeToolInput', () => {
    it('reduces a path to its basename', () => {
      expect(describeToolInput({ name: 'file_edit', input: { path: '/a/b/ChatService.ts' } })).toBe('ChatService.ts');
      expect(describeToolInput({ name: 'file_read', input: { file_path: 'C:\\x\\y\\Z.ts' } })).toBe('Z.ts');
    });

    it('prefers keys in order and skips non-strings', () => {
      expect(describeToolInput({ name: 'x', input: { path: 5, command: 'pnpm test', query: 'q' } })).toBe('pnpm test');
      expect(describeToolInput({ name: 'x', input: { pattern: '*.ts', query: 'q' } })).toBe('*.ts');
      expect(describeToolInput({ name: 'x', input: { url: 'https://example.com' } })).toBe('https://example.com');
    });

    it('is empty when nothing describes the call', () => {
      expect(describeToolInput({ name: 'x', input: {} })).toBe('');
    });

    it('collapses to one line and caps at 60 characters', () => {
      const detail = describeToolInput({ name: 'bash_execute', input: { command: `echo\n${'a'.repeat(100)}` } });
      expect(detail).not.toContain('\n');
      expect(detail.length).toBe(60);
      expect(detail.endsWith('...')).toBe(true);
    });
  });

  describe('toolKind', () => {
    // One row per tool registered in main/chat/tools/registry.ts, so a new name lands here on purpose.
    const table: ReadonlyArray<readonly [string, ToolKind]> = [
      ['apply_patch', 'edit'],
      ['file_write', 'edit'],
      ['file_edit', 'edit'],
      ['memory_write', 'edit'],
      ['todo_write', 'edit'],
      ['bash_execute', 'shell'],
      ['bash_background', 'shell'],
      ['bash_output', 'shell'],
      ['bash_list', 'shell'],
      ['bash_kill', 'shell'],
      ['web_search', 'web'],
      ['web_fetch', 'web'],
      ['browser_navigate', 'web'],
      ['browser_tabs', 'web'],
      ['browser_snapshot', 'web'],
      ['browser_click', 'web'],
      ['browser_type', 'web'],
      ['browser_press', 'web'],
      ['browser_scroll', 'web'],
      ['browser_back', 'web'],
      ['browser_screenshot', 'web'],
      ['browser_evaluate', 'web'],
      ['file_read', 'read'],
      ['glob_files', 'read'],
      ['grep_search', 'read'],
      ['memory_read', 'read'],
      ['mcp_list_servers', 'read'],
      ['session_list', 'agent'],
      ['session_read', 'agent'],
      ['session_spawn', 'agent'],
      ['session_send', 'agent'],
      ['session_archive', 'agent'],
      ['session_rename', 'agent'],
      ['session_delete', 'agent'],
      ['session_suggestion_update', 'agent'],
      ['session_suggestion_dismiss', 'agent'],
      ['explore', 'other'],
      ['skill', 'other'],
      ['ask_user', 'other'],
      ['request_directory', 'other'],
      ['screen_capture', 'other'],
      ['memory_delete', 'other'],
      ['generate_image', 'other'],
      ['generate_speech', 'other'],
      ['generate_sound_effect', 'other'],
      ['generate_music', 'other'],
      ['generate_video', 'other'],
      ['mcp_reconnect_server', 'other'],
      ['mcp_set_server_enabled', 'other'],
      ['mcp_remove_server', 'other'],
      ['mcp_add_server', 'other'],
      ['mcp_update_server', 'other'],
    ];

    it.each(table)('%s is %s', (name, kind) => {
      expect(toolKind(name)).toBe(kind);
    });

    it('is case-insensitive', () => {
      expect(toolKind('File_Edit')).toBe('edit');
    });
  });

  describe('activityLabel', () => {
    it('names a tool and its detail, trimming when there is none', () => {
      expect(activityLabel({ kind: 'tool', tool: 'file_edit', detail: 'X.ts' })).toBe('file_edit X.ts');
      expect(activityLabel({ kind: 'tool', tool: 'file_edit', detail: '' })).toBe('file_edit');
    });

    it('words each phase', () => {
      expect(activityLabel({ kind: 'phase', phase: 'waiting' })).toBe('Waiting on the model');
      expect(activityLabel({ kind: 'phase', phase: 'thinking' })).toBe('Thinking');
      expect(activityLabel({ kind: 'phase', phase: 'responding' })).toBe('Writing a reply');
      expect(activityLabel({ kind: 'phase', phase: 'writing-tool', tool: 'file_write' })).toBe('Preparing file_write');
    });
  });

  describe('agentNowText', () => {
    it('names the setup step ahead of any activity or snippet', () => {
      const preparing = (step: SessionSetupStep) =>
        agentNowText({
          state: 'working',
          preparing: step,
          activity: { kind: 'phase', phase: 'thinking' },
          lastSnippet: 'old',
        });
      expect(preparing('worktree')).toBe('Creating worktree');
      expect(preparing('starting')).toBe('Starting up');
    });

    it('falls back to the activity label once no longer preparing', () => {
      expect(agentNowText({ state: 'working', activity: { kind: 'phase', phase: 'thinking' } })).toBe(
        activityLabel({ kind: 'phase', phase: 'thinking' })
      );
    });

    it('names the call an agent is waiting to have approved', () => {
      const activity = { kind: 'tool', tool: 'bash_execute', detail: 'git push' } as const;
      expect(agentNowText({ state: 'needs-you', activity, lastSnippet: 'older' })).toBe(
        'Waiting for approval: bash_execute git push'
      );
      expect(
        agentNowText({ state: 'needs-you', activity: { kind: 'phase', phase: 'waiting' }, lastSnippet: 'older' })
      ).toBe('older');
    });
  });
});
