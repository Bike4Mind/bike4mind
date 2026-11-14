import { describe, expect, it } from 'vitest';
import type { ChatSessionStatus, ChatSessionSummary, ChatToolCall } from './chat';
import { needsYouCount } from './needsYou';
import {
  approvalSummary,
  EMPTY_WATCH_SNAPSHOT,
  buildWatchSnapshot,
  isQuickApproval,
  parseWatchPreferences,
  pickRoom,
  QUICK_SUMMARY_MAX,
  type WatchSnapshotInput,
} from './watch';

const T0 = Date.parse('2026-11-12T10:00:00Z');

function session(id: string, parentId: string | null, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id,
    title: `Title ${id}`,
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    messageCount: 1,
    ...(parentId ? { origin: { parentSessionId: parentId } } : {}),
    ...extra,
  } as ChatSessionSummary;
}

function call(extra: Partial<ChatToolCall> = {}): ChatToolCall {
  return {
    id: 'call-1',
    name: 'bash',
    input: { command: 'pnpm test' },
    status: 'awaiting-approval',
    approvalId: 'approval-1',
    approvalDetail: '$ pnpm test',
    ...extra,
  } as ChatToolCall;
}

function input(overrides: Partial<WatchSnapshotInput> = {}): WatchSnapshotInput {
  return {
    sessions: [session('root', null), session('a', 'root'), session('b', 'root')],
    statuses: new Map<string, ChatSessionStatus>(),
    activity: new Map(),
    pending: new Map(),
    needsYouSince: new Map(),
    unacknowledgedDone: new Set(),
    now: T0,
    ...overrides,
  };
}

describe('buildWatchSnapshot', () => {
  it('is idle when nothing runs, and leaves plain sessions out', () => {
    const snapshot = buildWatchSnapshot(input({ sessions: [...input().sessions, session('plain', null)] }));
    expect(snapshot.overall).toBe('idle');
    expect(snapshot.orchestrations.map(orchestration => orchestration.rootId)).toEqual(['root']);
    expect(snapshot.orchestrations[0].agents.map(agent => agent.id)).toEqual(['a', 'b']);
  });

  it('is working while any agent processes', () => {
    const snapshot = buildWatchSnapshot(input({ statuses: new Map([['a', 'processing']]) }));
    expect(snapshot.overall).toBe('working');
    expect(snapshot.orchestrations[0].agents[0].state).toBe('working');
  });

  it('puts needs-you above working, counting the way the dock badge does', () => {
    const statuses = new Map<string, ChatSessionStatus>([
      ['a', 'processing'],
      ['b', 'needs-action'],
    ]);
    const base = input({ statuses });
    const snapshot = buildWatchSnapshot(base);
    expect(snapshot.overall).toBe('needs-you');
    expect(snapshot.needsYouCount).toBe(needsYouCount(statuses, base.sessions));
    expect(snapshot.needsYouCount).toBe(1);
  });

  it('counts a decision-waiting worker task as needs-you with nothing pending or waiting since', () => {
    const waiting = session('a', 'root', {
      workerTask: { state: { status: 'completed', accepted: false } },
    } as Partial<ChatSessionSummary>);
    const base = input({ sessions: [session('root', null), waiting, session('b', 'root')] });
    const snapshot = buildWatchSnapshot(base);
    expect(snapshot.overall).toBe('needs-you');
    expect(snapshot.needsYouCount).toBe(1);
    expect(snapshot.needsYouCount).toBe(needsYouCount(new Map(), base.sessions));
    expect(snapshot.pending).toEqual([]);
  });

  it('is done only for a finished orchestration nobody has looked at yet', () => {
    expect(buildWatchSnapshot(input({ unacknowledgedDone: new Set(['root']) })).overall).toBe('done');
    expect(buildWatchSnapshot(input()).overall).toBe('idle');
    const stillWorking = input({ unacknowledgedDone: new Set(['root']), statuses: new Map([['a', 'processing']]) });
    expect(buildWatchSnapshot(stillWorking).overall).toBe('working');
  });

  it('lists pending approvals oldest first, labelled with their agent and orchestration', () => {
    const snapshot = buildWatchSnapshot(
      input({
        statuses: new Map([
          ['a', 'needs-action'],
          ['b', 'needs-action'],
        ]),
        pending: new Map([
          ['a', [call({ approvalId: 'late' })]],
          ['b', [call({ approvalId: 'early', approvalIrreversible: true })]],
        ]),
        needsYouSince: new Map([
          ['a', T0 + 5_000],
          ['b', T0 + 1_000],
        ]),
      })
    );
    expect(snapshot.pending.map(item => item.approvalId)).toEqual(['early', 'late']);
    expect(snapshot.pending[0]).toMatchObject({
      sessionId: 'b',
      rootId: 'root',
      agentTitle: 'Title b',
      orchestrationTitle: 'Title root',
      quick: false,
    });
    expect(snapshot.pending[1].summary).toBe('bash $ pnpm test');
    expect(snapshot.orchestrations[0].needsYouSince).toBe(T0 + 1_000);
  });

  it('drops pending calls of sessions that are not waiting any more', () => {
    const snapshot = buildWatchSnapshot(input({ pending: new Map([['a', [call()]]]) }));
    expect(snapshot.pending).toEqual([]);
  });

  it('carries the live activity text of each agent', () => {
    const snapshot = buildWatchSnapshot(
      input({
        statuses: new Map([['a', 'processing']]),
        activity: new Map([['a', { kind: 'tool', tool: 'read_file', detail: 'src/index.ts' }]]),
      })
    );
    expect(snapshot.orchestrations[0].agents[0].activity).toBe('read_file src/index.ts');
  });

  it('skips archived orchestrations', () => {
    const snapshot = buildWatchSnapshot(
      input({ sessions: [session('root', null, { archived: true }), session('a', 'root')] })
    );
    expect(snapshot).toEqual(EMPTY_WATCH_SNAPSHOT);
  });
});

describe('isQuickApproval', () => {
  it('accepts a bare approval, including a once-only one', () => {
    expect(isQuickApproval(call())).toBe(true);
    expect(isQuickApproval(call({ approvalOnceOnly: true }))).toBe(true);
  });

  it.each([
    ['no approval id', { approvalId: undefined }],
    ['irreversible', { approvalIrreversible: true }],
    ['a warning', { approvalWarning: 'Whole home folder' }],
    ['a gate reason', { approvalReasons: ['Runs code from deploy.sh, which was written in this session.'] }],
    ['a choice', { approvalChoice: { options: [] } as unknown as ChatToolCall['approvalChoice'] }],
    ['parts', { approvalParts: [{ text: 'rm -rf build' }] }],
    ['a diff', { approvalDiff: {} as ChatToolCall['approvalDiff'] }],
    ['diffs', { approvalDiffs: [] as unknown as ChatToolCall['approvalDiffs'] }],
    ['a question', { name: 'ask_user' }],
    ['a directory grant', { name: 'request_directory' }],
    ['an MCP server card', { name: 'mcp_add_server' }],
    ['a gate floor that asks in every mode', { approvalInAppOnly: true }],
    ['a second line hidden below the command', { approvalDetail: '$ git status\n\nrm -rf src' }],
    ['a working directory below the command', { approvalDetail: '$ rm -rf build\n\nin /tmp/elsewhere' }],
    ['a line separator', { approvalDetail: '$ git status\u2028rm -rf src' }],
    ['no detail of its own, only the cut-down input', { approvalDetail: undefined }],
    ['a summary too long to show whole', { approvalDetail: `$ echo ${'x'.repeat(QUICK_SUMMARY_MAX)}` }],
  ] as const)('refuses a call with %s', (_label, extra) => {
    expect(isQuickApproval(call(extra as Partial<ChatToolCall>))).toBe(false);
  });

  it('accepts a one-line detail that fits the summary exactly', () => {
    const detail = `$ ${'x'.repeat(QUICK_SUMMARY_MAX - 'bash $ '.length)}`;
    const fits = call({ approvalDetail: detail });
    expect(approvalSummary(fits)).toHaveLength(QUICK_SUMMARY_MAX);
    expect(isQuickApproval(fits)).toBe(true);
  });
});

describe('pickRoom', () => {
  const two = () =>
    buildWatchSnapshot(
      input({
        sessions: [
          session('r1', null),
          session('a1', 'r1', { updatedAt: new Date(T0 + 9_000).toISOString() }),
          session('r2', null),
          session('a2', 'r2'),
          session('r3', null),
          session('a3', 'r3'),
        ],
        statuses: new Map<string, ChatSessionStatus>([
          ['a1', 'processing'],
          ['a2', 'needs-action'],
          ['a3', 'needs-action'],
        ]),
        needsYouSince: new Map([
          ['a2', T0 + 4_000],
          ['a3', T0 + 2_000],
        ]),
      })
    );

  it('follows the request that has waited longest', () => {
    expect(pickRoom(two(), null)).toEqual({ rootId: 'r3', pinned: false, otherNeedsYou: false });
  });

  it('falls back to the most recently active orchestration', () => {
    const calm = buildWatchSnapshot(
      input({
        sessions: [
          session('r1', null),
          session('a1', 'r1'),
          session('r2', null),
          session('a2', 'r2', { updatedAt: new Date(T0 + 1).toISOString() }),
        ],
      })
    );
    expect(pickRoom(calm, null).rootId).toBe('r2');
  });

  it('holds a pinned room and flags that another one needs you', () => {
    expect(pickRoom(two(), 'r1')).toEqual({ rootId: 'r1', pinned: true, otherNeedsYou: true });
  });

  it('unpins a room that is gone', () => {
    expect(pickRoom(two(), 'missing')).toMatchObject({ rootId: 'r3', pinned: false });
  });

  it('has no room when nothing orchestrates', () => {
    expect(pickRoom(EMPTY_WATCH_SNAPSHOT, null)).toEqual({ rootId: null, pinned: false, otherNeedsYou: false });
  });
});

describe('parseWatchPreferences', () => {
  it('falls back to defaults for anything malformed', () => {
    expect(parseWatchPreferences(null)).toEqual({ showInMenuBar: true, miniOpen: false, miniBounds: null });
    expect(parseWatchPreferences({ showInMenuBar: 'yes', miniBounds: { x: 1 } })).toEqual({
      showInMenuBar: true,
      miniOpen: false,
      miniBounds: null,
    });
  });

  it('keeps valid values', () => {
    const value = { showInMenuBar: false, miniOpen: true, miniBounds: { x: 10, y: 20, width: 360, height: 220 } };
    expect(parseWatchPreferences(value)).toEqual(value);
  });
});

describe('approvalSummary', () => {
  it('keeps only the command line of a detail that carries warnings below it', () => {
    const call = {
      name: 'bash_execute',
      approvalDetail: '$ node -e "1"\n\nCan send data off this computer (node -e).',
    } as Parameters<typeof approvalSummary>[0];
    expect(approvalSummary(call)).toBe('bash_execute $ node -e "1"');
  });
});
