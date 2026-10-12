import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claimVoiceHold, restoreVoiceHold, incrementCredits, logInfo } = vi.hoisted(() => ({
  claimVoiceHold: vi.fn(),
  restoreVoiceHold: vi.fn(),
  incrementCredits: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { claimVoiceHold, restoreVoiceHold },
  userRepository: { incrementCredits },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info(...args: unknown[]) {
      logInfo(...args);
    }
  },
}));

import { settleVoiceHold, VOICE_HOLD_SETTLED_LOG } from './settleVoiceHold';
import { MAX_SESSION_SECONDS, REALTIME_VOICE_HOLD_SECONDS, realtimeCreditsFloor } from './voiceSessionLimits';

const STARTED = new Date('2026-10-11T12:00:00Z');
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);
const HOLD = { id: 's1', userId: 'u1', voiceReservedCredits: 600, voiceSessionStartedAt: STARTED };

describe('settleVoiceHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimVoiceHold.mockResolvedValue(true);
    restoreVoiceHold.mockResolvedValue(true);
  });

  it('bills connected time from the connect, not from the hold start, and refunds the rest', async () => {
    const connected = { ...HOLD, voiceConnectedAt: at(30) };

    const result = await settleVoiceHold(
      connected,
      { kind: 'connected-time', endedAt: at(30 + MAX_SESSION_SECONDS / 3) },
      'end'
    );

    expect(result).toEqual({ settled: true, connected: true, chargedCredits: 200, refundedCredits: 400 });
    expect(claimVoiceHold).toHaveBeenCalledWith('s1', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('u1', 400);
    expect(claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(incrementCredits.mock.invocationCallOrder[0]);
  });

  it('charges nothing for a call that never connected', async () => {
    const result = await settleVoiceHold(HOLD, { kind: 'connected-time', endedAt: at(MAX_SESSION_SECONDS) }, 'end');

    expect(result).toEqual({ settled: true, connected: false, chargedCredits: 0, refundedCredits: 600 });
    expect(incrementCredits).toHaveBeenCalledWith('u1', 600);
  });

  it('charges the whole hold, and refunds nothing, past the longest call', async () => {
    const connected = { ...HOLD, voiceConnectedAt: at(0) };

    const result = await settleVoiceHold(
      connected,
      { kind: 'connected-time', endedAt: at(MAX_SESSION_SECONDS * 3) },
      'sweep'
    );

    expect(result).toMatchObject({ chargedCredits: 600, refundedCredits: 0 });
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('bills reported realtime usage, charging what runs past the hold', async () => {
    const result = await settleVoiceHold(
      HOLD,
      { kind: 'realtime', reportedCredits: 650, openUntil: at(60) },
      'realtime-frame'
    );

    expect(result).toEqual({ settled: true, connected: true, chargedCredits: 650, refundedCredits: 0 });
    expect(incrementCredits).toHaveBeenCalledWith('u1', -50);
  });

  it('never settles realtime usage below the open-time floor, so a zero-usage frame still pays', async () => {
    const openFor = REALTIME_VOICE_HOLD_SECONDS / 2;

    const result = await settleVoiceHold(
      HOLD,
      { kind: 'realtime', reportedCredits: 0, openUntil: at(openFor) },
      'realtime-frame'
    );

    expect(result).toMatchObject({ chargedCredits: realtimeCreditsFloor(600, openFor), refundedCredits: 300 });
  });

  it('charges realtime usage straight from the balance when nothing was reserved', async () => {
    await settleVoiceHold(
      { ...HOLD, voiceReservedCredits: null },
      { kind: 'realtime', reportedCredits: 40, openUntil: at(1) },
      'realtime-frame'
    );

    expect(incrementCredits).toHaveBeenCalledWith('u1', -40);
  });

  it('moves no credits when another settler claimed the hold first', async () => {
    claimVoiceHold.mockResolvedValue(false);

    expect(await settleVoiceHold(HOLD, { kind: 'connected-time', endedAt: at(10) }, 'sweep')).toEqual({
      settled: false,
    });
    expect(incrementCredits).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('writes one aggregatable line per settlement', async () => {
    await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, { kind: 'connected-time', endedAt: at(60) }, 'sweep');

    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith(VOICE_HOLD_SETTLED_LOG, {
      source: 'sweep',
      userId: 'u1',
      sessionId: 's1',
      holdCredits: 600,
      chargedCredits: 120,
      refundedCredits: 480,
      connected: true,
    });
  });

  it('restores the hold with its markers and rethrows when moving the credits fails', async () => {
    const failure = new Error('db blip');
    incrementCredits.mockRejectedValue(failure);
    const connected = {
      ...HOLD,
      voiceConnectedAt: at(5),
      voiceLastActivityAt: at(50),
      voiceBillingMode: 'connected_time' as const,
    };

    await expect(settleVoiceHold(connected, { kind: 'connected-time', endedAt: at(50) }, 'sweep')).rejects.toBe(
      failure
    );
    expect(restoreVoiceHold).toHaveBeenCalledWith('s1', 600, STARTED, {
      voiceConnectedAt: at(5),
      voiceLastActivityAt: at(50),
      voiceBillingMode: 'connected_time',
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('surfaces both errors when the hold cannot be restored either', async () => {
    incrementCredits.mockRejectedValue(new Error('db blip'));
    restoreVoiceHold.mockRejectedValue(new Error('still down'));

    await expect(settleVoiceHold(HOLD, { kind: 'connected-time', endedAt: at(0) }, 'end')).rejects.toBeInstanceOf(
      AggregateError
    );
  });

  it('leaves the hold alone when no credits move', async () => {
    await settleVoiceHold(
      { ...HOLD, voiceConnectedAt: at(0) },
      { kind: 'connected-time', endedAt: at(MAX_SESSION_SECONDS) },
      'end'
    );

    expect(incrementCredits).not.toHaveBeenCalled();
    expect(restoreVoiceHold).not.toHaveBeenCalled();
  });
});
