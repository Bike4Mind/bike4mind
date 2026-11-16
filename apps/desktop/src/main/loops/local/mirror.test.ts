import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { loopMirrorSnapshotSchema } from '@bike4mind/common/loops';
import type { LocalLoopDetail } from '@shared/localLoops';
import { LoopMirror, MIRROR_MS, scrubLoop, type MirrorApi } from './mirror';
import { testLoop } from './testLoop';

const SECRET = 'TOP-SECRET';

const detail = (patch: Partial<LocalLoopDetail['loop']> = {}): LocalLoopDetail => ({
  loop: testLoop({
    goal: `goal ${SECRET}`,
    directory: `/Users/me/${SECRET}`,
    repo: `me/${SECRET}`,
    memory: { notes: SECRET, nextAction: SECRET },
    stageConfig: [{ stage: 'todo', instructions: SECRET, model: SECRET }],
    escalationModel: SECRET,
    budgetCreditsPerDay: 50,
    ...patch,
  }),
  lanesBusy: 1,
  spentToday: 7,
  needsYou: 1,
  idleReason: 'capped until 01:00 (daily budget)',
  tickets: [
    {
      id: 't1',
      loopId: 'loop-1',
      title: 'Fix the guide',
      description: SECRET,
      stage: 'todo',
      status: 'blocked',
      statusReason: 'CI is red',
      priority: 'p1',
      dependencies: [],
      runCount: 1,
      lastRunModel: SECRET,
      stageHistory: [],
      createdAt: '',
      updatedAt: '',
    },
  ],
  runs: [
    {
      id: 'r',
      loopId: 'loop-1',
      kind: 'ticket',
      sessionId: SECRET,
      model: SECRET,
      fallback: false,
      startedAt: '',
      credits: 1,
      reason: SECRET,
    },
  ],
  events: [{ id: 'e', loopId: 'loop-1', kind: 'asked', reason: SECRET, createdAt: '' }],
  directives: [
    {
      id: 'd',
      loopId: 'loop-1',
      fromLoopId: 'loop-2',
      fromLoopName: SECRET,
      runId: 'r',
      instruction: SECRET,
      reason: SECRET,
      state: 'open',
      replies: [],
      createdAt: '',
      updatedAt: '',
    },
  ],
});

describe('scrubLoop', () => {
  it('keeps status, lanes, spend and ticket titles, and nothing private', () => {
    const snapshot = scrubLoop(detail());
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(snapshot).toMatchObject({
      name: 'Docs',
      status: 'live',
      idleReason: 'capped until 01:00 (daily budget)',
      lanesBusy: 1,
      lanes: 1,
      spentToday: 7,
      budget: 50,
      needsYou: 1,
      tickets: [{ title: 'Fix the guide', stage: 'todo', status: 'blocked', priority: 'p1', reason: 'waiting on you' }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('CI is red');
    // The server's strict schema takes it as is.
    expect(loopMirrorSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });

  it('sends an error loop as the state only, not the run error text', () => {
    const snapshot = scrubLoop({
      ...detail({ status: 'error', error: SECRET }),
      idleReason: `error: 3 runs failed; last: ${SECRET}`,
    });
    expect(snapshot.idleReason).toBe('error');
  });
});

describe('LoopMirror', () => {
  let put: Mock<(path: string, body: unknown) => Promise<unknown>>;
  let del: Mock<(path: string) => Promise<unknown>>;
  let get: Mock<(path: string) => Promise<unknown>>;
  let details: LocalLoopDetail[];
  let warn: Mock<(message: string) => void>;
  let mirror: LoopMirror;

  beforeEach(() => {
    vi.useFakeTimers();
    put = vi.fn(async () => ({}));
    del = vi.fn(async () => ({}));
    get = vi.fn(async () => ({ loops: [] }));
    warn = vi.fn<(message: string) => void>();
    details = [detail()];
    mirror = new LoopMirror({
      api: () => ({ put, delete: del, get: get as MirrorApi['get'] }),
      details: () => details,
      logger: { warn },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('collapses a burst of changes into one post', async () => {
    for (let i = 0; i < 5; i++) mirror.changed();
    await vi.advanceTimersByTimeAsync(MIRROR_MS.debounce);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('/api/loops/mirror/loop-1', expect.objectContaining({ name: 'Docs' }));
  });

  it('never posts a loop with the mirror off, and takes one down once when it is turned off', async () => {
    details = [detail(), detail({ id: 'loop-2', mirror: false })];
    // The server still has loop-2 (turned off) and loop-9 (deleted while the app was closed).
    get.mockResolvedValue({ loops: [{ localLoopId: 'loop-1' }, { localLoopId: 'loop-2' }, { localLoopId: 'loop-9' }] });
    await mirror.flush();
    expect(put.mock.calls.map(([path]) => path)).toEqual(['/api/loops/mirror/loop-1']);
    // The first post after launch takes down what the server has but should not.
    expect(del.mock.calls.map(([path]) => path)).toEqual(['/api/loops/mirror/loop-2', '/api/loops/mirror/loop-9']);
    del.mockClear();
    details = [detail({ mirror: false })];
    await mirror.flush();
    await mirror.flush();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('/api/loops/mirror/loop-1');
  });

  it('survives the server being down: no throw, logged once, backing off', async () => {
    put.mockRejectedValue(new Error('503'));
    await expect(mirror.flush()).resolves.toBeUndefined();
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MIRROR_MS.backoffMin);
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(2);
    // Doubled: still backing off 30 s later.
    vi.advanceTimersByTime(MIRROR_MS.backoffMin);
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    put.mockResolvedValue({});
    vi.advanceTimersByTime(MIRROR_MS.backoffMin);
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(3);
  });

  it('a refused loop does not hold back the others or back off', async () => {
    details = [detail(), detail({ id: 'loop-2' })];
    put.mockRejectedValueOnce(Object.assign(new Error('400'), { response: { status: 400 } }));
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(2);
    await mirror.flush();
    expect(put).toHaveBeenCalledTimes(4);
  });

  it('posts nothing while signed out', async () => {
    mirror = new LoopMirror({ api: () => null, details: () => details, logger: { warn } });
    await mirror.flush();
    expect(put).not.toHaveBeenCalled();
  });
});
