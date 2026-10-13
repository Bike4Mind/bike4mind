import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findStaleVoiceHolds, claimVoiceHold, restoreVoiceHold, findTurns, incrementCredits, connectDB } = vi.hoisted(
  () => ({
    findStaleVoiceHolds: vi.fn(),
    claimVoiceHold: vi.fn(),
    restoreVoiceHold: vi.fn(),
    findTurns: vi.fn(),
    incrementCredits: vi.fn(),
    connectDB: vi.fn(async () => undefined),
  })
);

vi.mock('@bike4mind/database', () => ({
  connectDB,
  sessionRepository: { findStaleVoiceHolds, claimVoiceHold, restoreVoiceHold },
  questRepository: { findAllBySessionIdAndGreaterThanOrEqualToTimestamp: findTurns },
  userRepository: { incrementCredits },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info() {}
    warn() {}
    error() {}
  },
}));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import {
  handler,
  REALTIME_VOICE_HOLD_STALE_AFTER_MS,
  runVoiceHoldSweep,
  VOICE_HOLD_STALE_AFTER_MS,
  VOICE_HOLD_SWEEP_LIMIT,
} from './voiceHoldSweep';
import { MAX_SESSION_SECONDS, REALTIME_VOICE_HOLD_SECONDS } from '@server/voice/voiceSessionLimits';

const NOW = new Date('2026-10-11T12:00:00Z');
const STARTED = new Date(NOW.getTime() - 60 * 60 * 1000);
const RESERVED = 1000;
const hold = (id: string, realtime = false) => ({
  id,
  userId: `user-${id}`,
  voiceReservedCredits: RESERVED,
  voiceSessionStartedAt: STARTED,
  realtime,
});
const turnAt = (secondsAfterStart: number) => ({ timestamp: new Date(STARTED.getTime() + secondsAfterStart * 1000) });

describe('voiceHoldSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findStaleVoiceHolds.mockResolvedValue([]);
    claimVoiceHold.mockResolvedValue({ billedCredits: null });
    restoreVoiceHold.mockResolvedValue(true);
    findTurns.mockResolvedValue([]);
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

  it('keeps a realtime hold for what its responses billed and counts turns across its whole window', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a', true)]);
    claimVoiceHold.mockResolvedValue({ billedCredits: 100 });
    findTurns.mockResolvedValue([turnAt(REALTIME_VOICE_HOLD_SECONDS / 4)]);

    await runVoiceHoldSweep(NOW);

    // A quarter of the hold's own window owes a quarter of it, more than the 100 already billed.
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED - RESERVED / 4);
  });

  it('refunds the whole hold when the call never produced a turn', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);

    const result = await runVoiceHoldSweep(NOW);

    expect(claimVoiceHold).toHaveBeenCalledWith('a', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED);
    expect(result).toEqual({ candidates: 1, settled: 1, refundedCredits: RESERVED, alreadySettled: 0, failed: 0 });
  });

  it('keeps the evidenced call time, from the hold start to the last turn', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    findTurns.mockResolvedValue([turnAt(MAX_SESSION_SECONDS / 2), turnAt(10)]);

    await runVoiceHoldSweep(NOW);

    expect(findTurns).toHaveBeenCalledWith('a', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED / 2);
  });

  it('ignores turns past the longest call, so later typing in the session is not call time', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    findTurns.mockResolvedValue([turnAt(MAX_SESSION_SECONDS + 30 * 60)]);

    await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED);
  });

  it('keeps the last turn inside the window when later turns exist too', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    findTurns.mockResolvedValue([turnAt(MAX_SESSION_SECONDS * 4), turnAt(MAX_SESSION_SECONDS / 2)]);

    await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledWith('user-a', RESERVED / 2);
  });

  it('caps the charge at the hold', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    findTurns.mockResolvedValue([turnAt(MAX_SESSION_SECONDS)]);

    const result = await runVoiceHoldSweep(NOW);

    expect(incrementCredits).not.toHaveBeenCalled();
    expect(result.settled).toBe(1);
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
    findTurns.mockRejectedValueOnce(new Error('db blip'));

    const result = await runVoiceHoldSweep(NOW);

    expect(incrementCredits).toHaveBeenCalledTimes(1);
    expect(incrementCredits).toHaveBeenCalledWith('user-b', RESERVED);
    expect(result).toMatchObject({ settled: 1, failed: 1 });
  });

  it('restores a hold whose refund failed so the next run retries it', async () => {
    findStaleVoiceHolds.mockResolvedValue([hold('a')]);
    incrementCredits.mockRejectedValueOnce(new Error('db blip'));

    const result = await runVoiceHoldSweep(NOW);

    expect(restoreVoiceHold).toHaveBeenCalledWith('a', RESERVED, STARTED, null);
    expect(result).toMatchObject({ settled: 0, failed: 1 });
  });

  it('connects to the stage database before sweeping', async () => {
    await handler();
    expect(connectDB).toHaveBeenCalledWith('mongodb://host/test');
    expect(findStaleVoiceHolds).toHaveBeenCalledTimes(1);
  });
});
