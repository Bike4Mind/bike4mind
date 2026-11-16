import { describe, expect, it } from 'vitest';
import { assignPersonas } from './agentPersona';
import type { ChatMessage, ChatSessionStatus, ChatSessionSummary } from './chat';
import type { LocalLoopDetail, LocalTicket } from './localLoops';
import {
  alertableSessions,
  loopNeedsYouCount,
  loopNeedsYouItems,
  enteredNeedsYou,
  needsYouBody,
  needsYouCount,
  needsYouTitle,
  rootSessionOf,
} from './needsYou';

const session = (id: string, parentId?: string, title = `Session ${id}`): ChatSessionSummary =>
  ({
    id,
    title,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
  }) as ChatSessionSummary;

const statuses = (entries: Record<string, ChatSessionStatus>): ReadonlyMap<string, ChatSessionStatus> =>
  new Map(Object.entries(entries));

describe('enteredNeedsYou', () => {
  it('lists only the sessions that just moved into needs-action', () => {
    const before = statuses({ a: 'processing', b: 'needs-action', c: 'done' });
    const after = statuses({ a: 'needs-action', b: 'needs-action', c: 'done', d: 'needs-action' });
    expect(enteredNeedsYou(before, after)).toEqual(['a', 'd']);
  });

  it('counts a session again after it left needs-action and came back', () => {
    const left = statuses({ a: 'processing' });
    expect(enteredNeedsYou(statuses({ a: 'needs-action' }), left)).toEqual([]);
    expect(enteredNeedsYou(left, statuses({ a: 'needs-action' }))).toEqual(['a']);
  });
});

describe('needsYouCount', () => {
  const listed = [session('a'), session('b'), session('a1', 'a'), session('b1', 'b')];

  it('counts waiting sessions in an agent tree, parent and agents alike', () => {
    expect(needsYouCount(statuses({ a: 'needs-action', a1: 'needs-action', b1: 'processing' }), listed)).toBe(2);
    expect(needsYouCount(new Map(), listed)).toBe(0);
  });

  it('counts a worker task waiting on a decision, but not a queued or running one', () => {
    const task = (state: object, id: string) =>
      ({ ...session(id, 'root'), workerTask: { state } }) as unknown as ChatSessionSummary;
    const sessions = [
      session('root'),
      task({ status: 'completed', accepted: false }, 'done-unaccepted'),
      task({ status: 'completed', accepted: true }, 'done-accepted'),
      task({ status: 'queued' }, 'queued'),
      task({ status: 'running' }, 'running'),
    ];
    expect(needsYouCount(statuses({}), sessions)).toBe(1);
  });

  it('skips plain sessions, archived ones, those under an archived agent, and unlisted ones', () => {
    const sessions = [
      session('plain'),
      session('root'),
      { ...session('shelved', 'root'), archived: true },
      session('under', 'shelved'),
      session('live', 'root'),
    ];
    const waiting = statuses({
      plain: 'needs-action',
      shelved: 'needs-action',
      under: 'needs-action',
      live: 'needs-action',
      gone: 'needs-action',
    });
    expect(needsYouCount(waiting, sessions)).toBe(1);
    expect([...alertableSessions(sessions)].sort()).toEqual(['live', 'root']);
  });
});

describe('rootSessionOf', () => {
  it('walks up the spawn chain to the session that started it', () => {
    const sessions = [session('root'), session('child', 'root'), session('grandchild', 'child')];
    expect(rootSessionOf(sessions, 'grandchild')).toBe('root');
    expect(rootSessionOf(sessions, 'root')).toBe('root');
  });

  it('stops at the last listed ancestor, and survives a loop', () => {
    expect(rootSessionOf([session('child', 'gone')], 'child')).toBe('child');
    const looped = [session('a', 'b'), session('b', 'a')];
    expect(['a', 'b']).toContain(rootSessionOf(looped, 'a'));
  });
});

describe('needsYouTitle', () => {
  it('names an agent by the persona the Tavern shows, and a root by its title', () => {
    const sessions = [session('root', undefined, 'Audit'), session('child', 'root', 'Review the auth middleware')];
    const persona = assignPersonas([
      {
        id: 'child',
        createdAt: '2026-10-01T00:00:00.000Z',
        title: 'Review the auth middleware',
        seedPrompt: 'seed child',
      },
    ]).get('child');
    expect(persona?.label).toMatch(/ the Warden$/);
    expect(needsYouTitle(sessions, 'child', 'root')).toBe(`${persona?.label} needs you`);
    expect(needsYouTitle(sessions, 'root', 'root')).toBe('Audit needs you');
  });

  it('falls back to a generic name for a session that is not listed', () => {
    expect(needsYouTitle([], 'ghost', 'ghost')).toBe('A session needs you');
  });
});

describe('needsYouBody', () => {
  const at = '2026-10-01T00:00:00.000Z';
  it('describes the request parked at the approval gate', () => {
    const messages = [
      {
        id: 'm1',
        role: 'assistant',
        content: '',
        createdAt: at,
        toolCalls: [
          { id: 'c1', name: 'bash', input: { command: 'pnpm test' }, status: 'awaiting-approval', approvalId: 'ap1' },
        ],
      },
    ] as ChatMessage[];
    expect(needsYouBody(messages)).toBe('bash pnpm test');
  });

  it('says it is waiting when there is no parked call to describe', () => {
    expect(needsYouBody([])).toBe('Waiting for your answer');
  });
});

describe('loop needs-you items', () => {
  const ticket = (id: string, patch: Partial<LocalTicket>): LocalTicket => ({
    id,
    loopId: 'l1',
    title: `Ticket ${id}`,
    stage: 'todo',
    status: 'open',
    dependencies: [],
    runCount: 0,
    stageHistory: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  });
  const detail = {
    loop: { id: 'l1', name: 'Docs' },
    lanesBusy: 0,
    spentToday: 0,
    needsYou: 2,
    tickets: [
      ticket('asked', {
        status: 'blocked',
        statusReason: 'Unsure: Which color?',
        updatedAt: '2026-01-01T01:00:00.000Z',
      }),
      ticket('stuck', { status: 'blocked', statusReason: 'CI is red', updatedAt: '2026-01-01T02:00:00.000Z' }),
      ticket('waits', { status: 'blocked', blockedOn: 'dependencies' }),
      ticket('open', {}),
    ],
    runs: [],
    events: [
      { id: 'e2', loopId: 'l1', ticketId: 'asked', kind: 'asked', reason: 'Which color?', createdAt: '2' },
      { id: 'e1', loopId: 'l1', ticketId: 'asked', kind: 'asked', reason: 'Old', createdAt: '1' },
      {
        id: 'e0',
        loopId: 'l1',
        ticketId: 'stuck',
        kind: 'asked',
        reason: 'Answered',
        resolution: { outcome: 'answered', at: '1' },
        createdAt: '0',
      },
    ],
  } as unknown as LocalLoopDetail;

  it('lists blocked tickets not waiting on another ticket, newest first, with the latest open question', () => {
    expect(loopNeedsYouItems(detail)).toEqual([
      { loopId: 'l1', loopName: 'Docs', ticketId: 'stuck', title: 'Ticket stuck', reason: 'CI is red' },
      {
        loopId: 'l1',
        loopName: 'Docs',
        ticketId: 'asked',
        title: 'Ticket asked',
        reason: 'Unsure: Which color?',
        eventId: 'e2',
      },
    ]);
  });

  it('adds up the waiting tickets across loops, plus one per capped or errored loop', () => {
    const live = { status: 'live' };
    expect(
      loopNeedsYouCount([
        { needsYou: 2, loop: live },
        { needsYou: 0, loop: { status: 'error' } },
        { needsYou: 1, loop: { ...live, cappedUntil: '2026-01-02T00:00:00.000Z' } },
      ] as never)
    ).toBe(5);
  });

  it('puts the loop itself first when it is capped, in error, or stalled since its last run', () => {
    const top = (patch: object) => loopNeedsYouItems({ ...detail, ...patch } as LocalLoopDetail)[0];
    expect(top({ loop: { id: 'l1', name: 'Docs', status: 'error', error: 'boom' } })).toEqual({
      loopId: 'l1',
      loopName: 'Docs',
      title: 'Docs',
      reason: 'Error: boom',
    });
    expect(top({ loop: { id: 'l1', name: 'Docs', cappedUntil: 'x' }, idleReason: 'capped until 01:00' }).reason).toBe(
      'capped until 01:00'
    );
    const alarm = { id: 'a', loopId: 'l1', kind: 'alarm', reason: 'Ready work but no run for 30 min', createdAt: '5' };
    expect(top({ events: [alarm] }).reason).toBe('Stalled: Ready work but no run for 30 min');
    // A run started after the alarm: no longer stalled.
    expect(top({ events: [alarm], runs: [{ startedAt: '6' }] }).ticketId).toBe('stuck');
  });
});
