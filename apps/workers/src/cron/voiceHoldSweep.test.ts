import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findStaleVoiceHolds, claimVoiceHold, incrementCredits, createTransaction, connectDB, emitMetrics } = vi.hoisted(
  () => ({
    findStaleVoiceHolds: vi.fn(),
    claimVoiceHold: vi.fn(),
    incrementCredits: vi.fn(),
    createTransaction: vi.fn(),
    connectDB: vi.fn(async () => undefined),
    emitMetrics: vi.fn(async () => undefined),
  })
);

vi.mock('@bike4mind/database', () => ({
  connectDB,
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  sessionRepository: { findStaleVoiceHolds, claimVoiceHold },
  userRepository: { incrementCredits },
  creditTransactionRepository: { createTransaction },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetrics }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import {
  handler,
  REALTIME_VOICE_HOLD_STALE_AFTER_MS,
  runVoiceHoldSweep,
  VOICE_HOLD_STALE_AFTER_MS,
  VOICE_HOLD_SWEEP_LIMIT,
} from './voiceHoldSweep';
import {
  creditsForElapsed,
  MAX_SESSION_SECONDS,
  REALTIME_VOICE_HOLD_SECONDS,
  realtimeCreditsFloor,
} from '@bike4mind/server-utils/voice/voiceSessionLimits';

const NOW = new Date('2026-10-11T12:00:00Z');
const STARTED = new Date(NOW.getTime() - 60 * 60 * 1000);
const RESERVED = 1000;
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);
const hold = (
  id: string,
  voiceConnectedAt: Date | null = null,
  voiceLastActivityAt: Date | null = null,
  realtime = false
) => ({
  id,
  userId: `user-${id}`,
  voiceReservedCredits: RESERVED,
  voiceSessionStartedAt: STARTED,
  voiceConnectedAt,
  voiceLastActivityAt,
  realtime,
});

describe('voiceHoldSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findStaleVoiceHolds.mockResolvedValue([]);
    claimVoiceHold.mockResolvedValue({ billedCredits: null });
    createTransaction.mockImplementation(async (_type: string, row: object) => ({ id: 'tx', ...row }));
  });

  it('only asks for holds older than the longest call plus the safety margin, bounded per run', async () => {
    await runVoiceHoldSweep(NOW);

    const [startedBefore, realtimeStartedBefore, limit] = findStaleVoiceHolds.mock.calls[0];
    expect(NOW.getTime() - startedBefore.getTime()).toBe(VOICE_HOLD_STALE_AFTER_MS);
    expect(VOICE_HOLD_STALE_AFTER_MS).toBeGreaterThan(MAX_SESSION_SECONDS * 1000);
    expect(NOW.getTime() - realtimeStartedBefore.getTime()).toBe(REALTIME_VOICE_HOLD_STALE_AFTER_MS);
    expect(REALTIME_VOICE_HOLD_STALE_AFTER_MS).toBeGreaterThan(REALTIME_VOICE_HOLD_SECONDS * 1000);
    expect(limit).toBe(VOICE_HOLD_SWEEP_LIMIT);
  });

  it('charges a silent connected call closed via its tab for its connected time', async () => {
    // Connected 10 s after the hold opened; heartbeats stopped 150 s later when the tab closed.
    findStaleVoiceHolds.mockResolvedValue([hold('a', at(10), at(160))]);

    await runVoiceHoldSweep(NOW);

    const charged = creditsForElapsed(RESERVED, 150);
    expect(charged).toBeGreaterThan(0);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED - charged);
  });

  it('refunds the whole hold of a call that never connected', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);

    const result = await runVoiceHoldSweep(NOW);

    expect(claimVoiceHold).toHaveBeenCalledWith('a', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED);
    expect(result).toEqual({ candidates: 1, settled: 1, refundedCredits: RESERVED, alreadySettled: 0, failed: 0 });
  });

  it('charges the whole hold for a call that ran past the cap', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a', at(5), at(5 + MAX_SESSION_SECONDS * 2))]);

    const result = await runVoiceHoldSweep(NOW);

    expect(incrementCredits).not.toHaveBeenCalled();
    expect(result).toMatchObject({ settled: 1, refundedCredits: 0 });
  });

  it('bills nothing past the connect when a connected call never reported again', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a', at(10))]);

    await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED);
  });

  it('moves no credits for a hold another settler claimed first', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    claimVoiceHold.mockResolvedValue(null);

    const result = await runVoiceHoldSweep(NOW);

    expect(incrementCredits).not.toHaveBeenCalled();
    expect(result).toMatchObject({ settled: 0, alreadySettled: 1 });
  });

  it('keeps sweeping after one hold fails', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a'), hold('b')]);
    claimVoiceHold.mockRejectedValueOnce(new Error('db blip'));

    const result = await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledTimes(1);
    expect(incrementCredits).toHaveBeenCalledWith('user-b', RESERVED);
    expect(result).toMatchObject({ settled: 1, failed: 1 });
  });

  it('charges an abandoned realtime hold the open-time floor up to the last frame the server saw', async () => {
    // No closing frame ever settled it; frames kept arriving for 20 minutes.
    findStaleVoiceHolds.mockResolvedValue([hold('a', at(3), at(20 * 60), true)]);
    claimVoiceHold.mockResolvedValue({ billedCredits: 0 });

    await runVoiceHoldSweep(NOW);

    const floor = realtimeCreditsFloor(RESERVED, 20 * 60);
    expect(floor).toBeGreaterThan(0);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED - floor);
  });

  it('keeps what an abandoned realtime hold billed when that is more than its floor', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a', at(3), at(60), true)]);
    claimVoiceHold.mockResolvedValue({ billedCredits: 300 });

    await runVoiceHoldSweep(NOW);

    expect(realtimeCreditsFloor(RESERVED, 60)).toBeLessThan(300);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED - 300);
  });

  it('refunds a realtime hold the server never saw a frame for', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a', null, null, true)]);
    claimVoiceHold.mockResolvedValue({ billedCredits: 0 });

    await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED);
  });

  it('counts a hold whose refund failed as failed, for the next run to retry', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    incrementCredits.mockRejectedValueOnce(new Error('db blip'));

    const result = await runVoiceHoldSweep(NOW);

    expect(result).toMatchObject({ settled: 0, refundedCredits: 0, failed: 1 });
  });

  it('connects to the stage database before sweeping', async () => {
    await handler();
    expect(connectDB).toHaveBeenCalledWith('mongodb://host/test');
    expect(findStaleVoiceHolds).toHaveBeenCalledTimes(1);
  });

  // The alarms in infra/alarms.ts match on this namespace, these names and exactly { Stage }.
  it('publishes the settled and failed counts for the stage alarms', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a'), hold('b')]);
    incrementCredits.mockRejectedValueOnce(new Error('db blip'));

    await handler();

    expect(emitMetrics).toHaveBeenCalledTimes(1);
    expect(emitMetrics).toHaveBeenCalledWith('Lumina5/Voice', [
      { name: 'HoldSweepSettled', value: 1, dimensions: { Stage: 'test' }, unit: 'Count' },
      { name: 'HoldSweepFailed', value: 1, dimensions: { Stage: 'test' }, unit: 'Count' },
    ]);
  });

  it('reports a run that fails before reaching the holds as a failure, and still throws', async () => {
    findStaleVoiceHolds.mockRejectedValueOnce(new Error('query failed'));

    await expect(handler()).rejects.toThrow('query failed');

    expect(emitMetrics).toHaveBeenCalledWith('Lumina5/Voice', [
      { name: 'HoldSweepSettled', value: 0, dimensions: { Stage: 'test' }, unit: 'Count' },
      { name: 'HoldSweepFailed', value: 1, dimensions: { Stage: 'test' }, unit: 'Count' },
    ]);
  });

  it('reports a run that cannot reach the database as a failure, and still throws', async () => {
    connectDB.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(handler()).rejects.toThrow('database unreachable');

    expect(findStaleVoiceHolds).not.toHaveBeenCalled();
    expect(emitMetrics).toHaveBeenCalledWith('Lumina5/Voice', [
      { name: 'HoldSweepSettled', value: 0, dimensions: { Stage: 'test' }, unit: 'Count' },
      { name: 'HoldSweepFailed', value: 1, dimensions: { Stage: 'test' }, unit: 'Count' },
    ]);
  });

  it('leaves metrics to the hosted handler, so the self-host twin never calls CloudWatch', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);

    await runVoiceHoldSweep(NOW);

    expect(emitMetrics).not.toHaveBeenCalled();
  });
});
