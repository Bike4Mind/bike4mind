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

import { lastSeenAt, settlePriorVoiceHold, settleVoiceHold, VOICE_HOLD_SETTLED_LOG } from './settleVoiceHold';
import { MAX_SESSION_SECONDS, REALTIME_VOICE_HOLD_SECONDS, realtimeCreditsFloor } from './voiceSessionLimits';

const STARTED = new Date('2026-10-11T12:00:00Z');
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);
const HOLD = { id: 's1', userId: 'u1', voiceReservedCredits: 600, voiceSessionStartedAt: STARTED };

describe('settleVoiceHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimVoiceHold.mockResolvedValue({ billedCredits: null });
    restoreVoiceHold.mockResolvedValue(true);
    incrementCredits.mockResolvedValue(undefined);
  });

  it('bills connected time from the connect, not from the hold start, and refunds the rest', async () => {
    const connected = { ...HOLD, voiceConnectedAt: at(30) };

    const result = await settleVoiceHold(connected, at(30 + MAX_SESSION_SECONDS / 3), 'end');

    expect(result).toEqual({ settled: true, connected: true, chargedCredits: 200, refundedCredits: 400 });
    expect(claimVoiceHold).toHaveBeenCalledWith('s1', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('u1', 400);
    expect(claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(incrementCredits.mock.invocationCallOrder[0]);
  });

  it('charges nothing for a call that never connected', async () => {
    const result = await settleVoiceHold(HOLD, at(MAX_SESSION_SECONDS), 'end');

    expect(result).toEqual({ settled: true, connected: false, chargedCredits: 0, refundedCredits: 600 });
    expect(incrementCredits).toHaveBeenCalledWith('u1', 600);
  });

  it('charges the whole hold, and refunds nothing, past the longest call', async () => {
    const connected = { ...HOLD, voiceConnectedAt: at(0) };

    const result = await settleVoiceHold(connected, at(MAX_SESSION_SECONDS * 3), 'sweep');

    expect(result).toMatchObject({ chargedCredits: 600, refundedCredits: 0 });
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('keeps what realtime responses already drew from the hold, even with no open time', async () => {
    claimVoiceHold.mockResolvedValue({ billedCredits: 250 });

    const result = await settleVoiceHold(HOLD, STARTED, 'sweep');

    expect(result).toEqual({ settled: true, connected: true, chargedCredits: 250, refundedCredits: 350 });
  });

  it('never settles a realtime hold below its open-time floor, so a silent call still pays', async () => {
    claimVoiceHold.mockResolvedValue({ billedCredits: 0 });
    const openFor = REALTIME_VOICE_HOLD_SECONDS / 2;

    const result = await settleVoiceHold(HOLD, at(openFor), 'sweep');

    expect(result).toMatchObject({ chargedCredits: realtimeCreditsFloor(600, openFor), refundedCredits: 300 });
  });

  it('refunds nothing on a realtime hold whose responses billed past it', async () => {
    claimVoiceHold.mockResolvedValue({ billedCredits: 900 });

    const result = await settleVoiceHold(HOLD, at(60), 'sweep');

    expect(result).toMatchObject({ chargedCredits: 600, refundedCredits: 0 });
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('moves no credits when another settler claimed the hold first', async () => {
    claimVoiceHold.mockResolvedValue(null);

    expect(await settleVoiceHold(HOLD, at(10), 'sweep')).toEqual({ settled: false });
    expect(incrementCredits).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('writes one aggregatable line per settlement', async () => {
    await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, at(60), 'sweep');

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

  it('restores the hold with its markers and rethrows when crediting back fails', async () => {
    const failure = new Error('db blip');
    incrementCredits.mockRejectedValue(failure);
    const connected = { ...HOLD, voiceConnectedAt: at(5), voiceLastActivityAt: at(50) };

    await expect(settleVoiceHold(connected, at(50), 'sweep')).rejects.toBe(failure);
    expect(restoreVoiceHold).toHaveBeenCalledWith('s1', 600, STARTED, {
      voiceConnectedAt: at(5),
      voiceLastActivityAt: at(50),
      voiceBilledCredits: null,
    });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('restores the billed total along with a realtime hold whose refund failed', async () => {
    claimVoiceHold.mockResolvedValue({ billedCredits: 250 });
    incrementCredits.mockRejectedValue(new Error('db blip'));

    await expect(settleVoiceHold(HOLD, STARTED, 'sweep')).rejects.toThrow('db blip');
    expect(restoreVoiceHold).toHaveBeenCalledWith(
      's1',
      600,
      STARTED,
      expect.objectContaining({ voiceBilledCredits: 250 })
    );
  });

  it('surfaces both errors when the hold cannot be restored either', async () => {
    incrementCredits.mockRejectedValue(new Error('db blip'));
    restoreVoiceHold.mockRejectedValue(new Error('still down'));

    await expect(settleVoiceHold(HOLD, at(0), 'end')).rejects.toBeInstanceOf(AggregateError);
  });

  it('leaves the hold alone when there is nothing to refund', async () => {
    await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, at(MAX_SESSION_SECONDS), 'end');

    expect(incrementCredits).not.toHaveBeenCalled();
    expect(restoreVoiceHold).not.toHaveBeenCalled();
  });
});

describe('lastSeenAt', () => {
  it('prefers the last activity, then the connect, then the hold start', () => {
    expect(lastSeenAt({ ...HOLD, voiceConnectedAt: at(5), voiceLastActivityAt: at(90) })).toEqual(at(90));
    expect(lastSeenAt({ ...HOLD, voiceConnectedAt: at(5) })).toEqual(at(5));
    expect(lastSeenAt(HOLD)).toEqual(STARTED);
  });
});

describe('settlePriorVoiceHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimVoiceHold.mockResolvedValue({ billedCredits: null });
    incrementCredits.mockResolvedValue(undefined);
  });

  it('settles an open hold up to when its call was last seen', async () => {
    const result = await settlePriorVoiceHold({ ...HOLD, voiceConnectedAt: at(0), voiceLastActivityAt: at(60) });

    expect(result).toMatchObject({ settled: true, chargedCredits: 120, refundedCredits: 480 });
    expect(logInfo).toHaveBeenCalledWith(VOICE_HOLD_SETTLED_LOG, expect.objectContaining({ source: 'bootstrap' }));
  });

  it('does nothing on a session with no open hold', async () => {
    expect(await settlePriorVoiceHold({ id: 's1', userId: 'u1', voiceReservedCredits: null })).toEqual({
      settled: false,
    });
    expect(claimVoiceHold).not.toHaveBeenCalled();
  });
});
