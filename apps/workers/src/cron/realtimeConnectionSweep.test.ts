import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
  readSweepPage: vi.fn(),
  classifySweepRows: vi.fn(),
  endConnections: vi.fn(),
  endExpiredConnections: vi.fn(),
  deleteEndedConnections: vi.fn(),
  removeOrphanSubscribers: vi.fn(),
  removeStaleSubscribers: vi.fn(),
  accountBlockReasons: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connectDB,
  realtimeConnectionRepository: {
    readSweepPage: mocks.readSweepPage,
    classifySweepRows: mocks.classifySweepRows,
    endConnections: mocks.endConnections,
    endExpiredConnections: mocks.endExpiredConnections,
    deleteEndedConnections: mocks.deleteEndedConnections,
    removeOrphanSubscribers: mocks.removeOrphanSubscribers,
    removeStaleSubscribers: mocks.removeStaleSubscribers,
  },
}));
vi.mock('@bike4mind/services', () => ({ userService: { accountBlockReasons: mocks.accountBlockReasons } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('@server/websocket/closeConnection', () => ({ closeConnection: vi.fn() }));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'test' }, websocket: { managementEndpoint: 'https://ws.example.com/test' } },
}));

import {
  REALTIME_SWEEP_CLOSE_CONCURRENCY,
  REALTIME_SWEEP_GRACE_MS,
  runRealtimeConnectionSweep,
} from './realtimeConnectionSweep';

const NOW = new Date('2026-10-14T12:00:00.000Z');
const ENDPOINT = 'https://ws.example.com/test';

type Target = { connectionId: string; reason: string };

/** One page per phase: the live phase returns `live`, the ended phase `ended`. */
function givenTargets(byPhase: { live?: Target[]; ended?: Target[] }) {
  mocks.readSweepPage.mockImplementation(async (cursor: { phase: 'live' | 'ended' }) => ({
    rows: [{ phase: cursor.phase }],
    next: null,
  }));
  mocks.classifySweepRows.mockImplementation(async (rows: { phase: 'live' | 'ended' }[]) =>
    rows[0].phase === 'live' ? (byPhase.live ?? []) : (byPhase.ended ?? [])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  givenTargets({
    live: [
      { connectionId: 'c-expired', reason: 'expired' },
      { connectionId: 'c-stale', reason: 'tokenVersionStale' },
    ],
    ended: [
      { connectionId: 'c-ended', reason: 'ended' },
      { connectionId: 'c-lapsed', reason: 'endedLapsed' },
    ],
  });
  mocks.endConnections.mockImplementation(async ({ connectionIds }: { connectionIds: string[] }) => ({
    connectionIds,
  }));
  mocks.endExpiredConnections.mockImplementation(async (connectionIds: string[]) => connectionIds);
  mocks.deleteEndedConnections.mockResolvedValue(0);
  mocks.removeOrphanSubscribers.mockResolvedValue(3);
  mocks.removeStaleSubscribers.mockResolvedValue(1);
});

const deletedIds = () => mocks.deleteEndedConnections.mock.calls.flatMap(([ids]) => ids as string[]);

describe('realtimeConnectionSweep cron', () => {
  it('ends lapsed connections, closes every ended socket, deletes the closed rows, and cleans subscribers', async () => {
    const close = vi.fn(async () => undefined);

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://host/test');
    expect(mocks.endExpiredConnections).toHaveBeenCalledWith(
      ['c-expired'],
      new Date(NOW.getTime() - REALTIME_SWEEP_GRACE_MS)
    );
    expect(mocks.endConnections).toHaveBeenCalledWith({ connectionIds: ['c-stale'] });
    expect(close.mock.calls.map(([id]) => id).sort()).toEqual(['c-ended', 'c-expired', 'c-stale']);
    expect(close).toHaveBeenCalledWith('c-ended', ENDPOINT);
    // The lapsed row is deleted without a close.
    expect(close).not.toHaveBeenCalledWith('c-lapsed', expect.anything());
    expect(deletedIds().sort()).toEqual(['c-ended', 'c-expired', 'c-lapsed', 'c-stale']);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
    expect(mocks.removeStaleSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ended: 2,
      closed: 3,
      closeFailures: 0,
      lapsedDeleted: 1,
      failedChunks: 0,
      orphanedSubscribers: 3,
      staleSubscribers: 1,
    });
  });

  it('treats a close that resolves (including an already-gone socket) as closed, so the row is deleted', async () => {
    await runRealtimeConnectionSweep({ now: NOW, close: vi.fn(async () => undefined) });

    expect(deletedIds()).toContain('c-ended');
  });

  it('keeps the ended row for the next run when the close fails for another reason', async () => {
    const close = vi.fn(async (connectionId: string) => {
      if (connectionId === 'c-stale' || connectionId === 'c-ended') throw new Error('network');
    });

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(deletedIds()).not.toContain('c-stale');
    expect(deletedIds()).not.toContain('c-ended');
    expect(deletedIds()).toContain('c-expired');
    expect(close).toHaveBeenCalledTimes(3);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ closed: 1, closeFailures: 2 });
  });

  it('deletes an ended row older than any socket can live without trying to close it', async () => {
    givenTargets({ ended: [{ connectionId: 'c-lapsed', reason: 'endedLapsed' }] });
    const close = vi.fn();

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).not.toHaveBeenCalled();
    expect(mocks.deleteEndedConnections).toHaveBeenCalledWith(['c-lapsed']);
    expect(result.lapsedDeleted).toBe(1);
  });

  it('does not end or close an expired row that was reauthed after classification', async () => {
    givenTargets({ live: [{ connectionId: 'c-reauthed', reason: 'expired' }] });
    mocks.endExpiredConnections.mockResolvedValue([]);
    const close = vi.fn(async () => undefined);

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).not.toHaveBeenCalled();
    expect(deletedIds()).not.toContain('c-reauthed');
    expect(result).toMatchObject({ ended: 0, closed: 0, closeFailures: 0 });
  });

  it('does not close again, or count again, a live-phase target whose close failed earlier in the run', async () => {
    givenTargets({
      live: [{ connectionId: 'c-flaky', reason: 'expired' }],
      ended: [{ connectionId: 'c-flaky', reason: 'ended' }],
    });
    const close = vi.fn(async () => {
      throw new Error('network');
    });

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ closed: 0, closeFailures: 1 });
  });

  it('still runs the stale pass when the orphan pass throws', async () => {
    mocks.removeOrphanSubscribers.mockRejectedValue(new Error('mongo down'));

    const result = await runRealtimeConnectionSweep({ now: NOW, close: vi.fn(async () => undefined) });

    expect(mocks.removeStaleSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failedChunks: 1, staleSubscribers: 1, orphanedSubscribers: 0 });
  });

  it('closes at most the concurrency cap at a time', async () => {
    const live = Array.from({ length: REALTIME_SWEEP_CLOSE_CONCURRENCY * 2 + 3 }, (_, i) => ({
      connectionId: `c-${i}`,
      reason: 'expired',
    }));
    givenTargets({ live });
    let inFlight = 0;
    let peak = 0;
    const close = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
    });

    await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).toHaveBeenCalledTimes(live.length);
    expect(peak).toBe(REALTIME_SWEEP_CLOSE_CONCURRENCY);
  });

  it('skips a chunk that fails with a database error and still processes later chunks and the orphan pass', async () => {
    mocks.readSweepPage.mockImplementation(async (cursor: { phase: 'live' | 'ended'; afterId: string | null }) => {
      if (cursor.phase === 'ended') return { rows: [], next: null };
      return cursor.afterId
        ? { rows: [{ page: 2 }], next: null }
        : { rows: [{ page: 1 }], next: { phase: 'live', afterId: 'p1' } };
    });
    mocks.classifySweepRows.mockImplementation(async (rows: { page?: number }[]) => {
      if (rows[0]?.page === 1) throw new Error('mongo hiccup');
      return rows[0]?.page === 2 ? [{ connectionId: 'c-second-chunk', reason: 'expired' }] : [];
    });
    const close = vi.fn(async () => undefined);

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).toHaveBeenCalledWith('c-second-chunk', ENDPOINT);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ failedChunks: 1, ended: 1, closed: 1, orphanedSubscribers: 3 });
  });

  it('survives a failing end step in one chunk and still runs the orphan pass', async () => {
    mocks.endConnections.mockRejectedValueOnce(new Error('mongo hiccup'));

    const result = await runRealtimeConnectionSweep({ now: NOW, close: vi.fn(async () => undefined) });

    expect(result.failedChunks).toBe(1);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
  });

  it('still runs the subscriber passes when reading a page fails', async () => {
    mocks.readSweepPage.mockRejectedValue(new Error('mongo down'));

    const result = await runRealtimeConnectionSweep({ now: NOW, close: vi.fn() });

    expect(result.failedChunks).toBe(2);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
  });

  it('judges account state with userService.accountBlockReasons', async () => {
    await runRealtimeConnectionSweep({ now: NOW, close: vi.fn(async () => undefined) });
    const [, params] = mocks.classifySweepRows.mock.calls[0] as [
      unknown,
      { now: Date; graceMs: number; isAccountBlocked: (user: unknown) => boolean },
    ];

    expect(params).toMatchObject({ now: NOW, graceMs: REALTIME_SWEEP_GRACE_MS });
    mocks.accountBlockReasons.mockReturnValueOnce(['banned']);
    expect(params.isAccountBlocked({ isBanned: true })).toBe(true);
    mocks.accountBlockReasons.mockReturnValueOnce([]);
    expect(params.isAccountBlocked({})).toBe(false);
  });
});
