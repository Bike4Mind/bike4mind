import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectDB: vi.fn(async () => undefined),
  findSweepTargets: vi.fn(),
  endConnections: vi.fn(),
  removeOrphanSubscribers: vi.fn(),
  accountBlockReasons: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connectDB,
  realtimeConnectionRepository: {
    findSweepTargets: mocks.findSweepTargets,
    endConnections: mocks.endConnections,
    removeOrphanSubscribers: mocks.removeOrphanSubscribers,
  },
}));
vi.mock('@bike4mind/services', () => ({ userService: { accountBlockReasons: mocks.accountBlockReasons } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('@server/websocket/closeConnection', () => ({ closeConnection: vi.fn() }));
vi.mock('sst', () => ({
  Resource: { App: { stage: 'test' }, websocket: { managementEndpoint: 'https://ws.example.com/test' } },
}));

import { REALTIME_SWEEP_GRACE_MS, runRealtimeConnectionSweep } from './realtimeConnectionSweep';

const NOW = new Date('2026-10-14T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSweepTargets.mockResolvedValue([
    { connectionId: 'c-expired', reason: 'expired' },
    { connectionId: 'c-stale', reason: 'tokenVersionStale' },
    { connectionId: 'c-revoked', reason: 'sessionRevoked' },
    { connectionId: 'c-banned', reason: 'accountBlocked' },
  ]);
  mocks.endConnections.mockImplementation(async ({ connectionIds }: { connectionIds: string[] }) => ({
    connectionIds,
  }));
  mocks.removeOrphanSubscribers.mockResolvedValue(3);
});

describe('realtimeConnectionSweep cron', () => {
  it('ends every target, closes each socket and removes orphan subscribers', async () => {
    const close = vi.fn(async () => undefined);

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(mocks.connectDB).toHaveBeenCalledWith('mongodb://host/test');
    expect(mocks.findSweepTargets).toHaveBeenCalledWith(
      expect.objectContaining({ now: NOW, graceMs: REALTIME_SWEEP_GRACE_MS })
    );
    expect(mocks.endConnections).toHaveBeenCalledWith({
      connectionIds: ['c-expired', 'c-stale', 'c-revoked', 'c-banned'],
    });
    expect(close).toHaveBeenCalledTimes(4);
    expect(close).toHaveBeenCalledWith('c-banned', 'https://ws.example.com/test');
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ended: 4, closeFailures: 0, orphanedSubscribers: 3 });
  });

  it('keeps closing the rest of the batch when one close fails', async () => {
    const close = vi.fn(async (connectionId: string) => {
      if (connectionId === 'c-stale') throw new Error('network');
    });

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(close).toHaveBeenCalledTimes(4);
    expect(mocks.removeOrphanSubscribers).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ended: 4, closeFailures: 1, orphanedSubscribers: 3 });
  });

  it('still removes orphan subscribers when nothing needs ending', async () => {
    mocks.findSweepTargets.mockResolvedValue([]);
    const close = vi.fn();

    const result = await runRealtimeConnectionSweep({ now: NOW, close });

    expect(mocks.endConnections).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(result).toEqual({ ended: 0, closeFailures: 0, orphanedSubscribers: 3 });
  });

  it('judges account state with userService.accountBlockReasons', async () => {
    await runRealtimeConnectionSweep({ now: NOW, close: vi.fn() });
    const { isAccountBlocked } = mocks.findSweepTargets.mock.calls[0][0] as {
      isAccountBlocked: (user: unknown) => boolean;
    };

    mocks.accountBlockReasons.mockReturnValueOnce(['banned']);
    expect(isAccountBlocked({ isBanned: true })).toBe(true);
    mocks.accountBlockReasons.mockReturnValueOnce([]);
    expect(isAccountBlocked({})).toBe(false);
  });
});
