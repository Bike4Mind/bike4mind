import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claimVoiceHold, openVoiceHold, incrementCredits, createTransaction, logInfo, logError } = vi.hoisted(() => ({
  claimVoiceHold: vi.fn(),
  openVoiceHold: vi.fn(),
  incrementCredits: vi.fn(),
  createTransaction: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  sessionRepository: { claimVoiceHold, openVoiceHold },
  userRepository: { incrementCredits },
  creditTransactionRepository: { createTransaction },
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    info(...args: unknown[]) {
      logInfo(...args);
    }
    error(...args: unknown[]) {
      logError(...args);
    }
  },
}));

import {
  lastSeenAt,
  reserveVoiceHold,
  settlePriorVoiceHold,
  settleVoiceHold,
  VOICE_HOLD_SETTLED_LOG,
  voiceHoldSettleTransactionId,
} from './settleVoiceHold';
import {
  MAX_SESSION_SECONDS,
  REALTIME_VOICE_HOLD_SECONDS,
  realtimeCreditsFloor,
} from '@bike4mind/server-utils/voice/voiceSessionLimits';

const STARTED = new Date('2026-10-11T12:00:00Z');
const at = (seconds: number) => new Date(STARTED.getTime() + seconds * 1000);
const HOLD = { id: 's1', userId: 'u1', voiceReservedCredits: 600, voiceSessionStartedAt: STARTED };

describe('settleVoiceHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimVoiceHold.mockResolvedValue({ billedCredits: null });
    incrementCredits.mockResolvedValue(undefined);
    createTransaction.mockImplementation(async (_type: string, row: object) => ({ id: 'tx', ...row }));
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

  it('rethrows a failed refund without logging a settlement', async () => {
    const failure = new Error('db blip');
    incrementCredits.mockRejectedValue(failure);

    await expect(settleVoiceHold({ ...HOLD, voiceConnectedAt: at(5) }, at(50), 'sweep')).rejects.toBe(failure);
    expect(createTransaction).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('records the connected-time charge as one ledger row keyed on the hold', async () => {
    await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, at(60), 'end');

    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(createTransaction).toHaveBeenCalledWith(
      'realtime_voice_usage',
      expect.objectContaining({
        ownerId: 'u1',
        sessionId: 's1',
        credits: -120,
        transactionId: voiceHoldSettleTransactionId('s1', STARTED),
      })
    );
  });

  it('records only the part of a realtime charge its responses did not already record', async () => {
    claimVoiceHold.mockResolvedValue({ billedCredits: 0 });
    const openFor = REALTIME_VOICE_HOLD_SECONDS / 2;

    await settleVoiceHold(HOLD, at(openFor), 'sweep');
    expect(createTransaction).toHaveBeenCalledWith(
      'realtime_voice_usage',
      expect.objectContaining({ credits: -realtimeCreditsFloor(600, openFor) })
    );

    createTransaction.mockClear();
    claimVoiceHold.mockResolvedValue({ billedCredits: 250 });
    await settleVoiceHold(HOLD, STARTED, 'sweep');
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it('reports nothing settled when the hold already has its settlement row', async () => {
    createTransaction.mockResolvedValue(null);

    expect(await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, at(60), 'end')).toEqual({ settled: false });
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('leaves the hold alone when there is nothing to refund', async () => {
    await settleVoiceHold({ ...HOLD, voiceConnectedAt: at(0) }, at(MAX_SESSION_SECONDS), 'end');

    expect(incrementCredits).not.toHaveBeenCalled();
  });
});

describe('reserveVoiceHold', () => {
  const RESERVE = {
    userId: 'u1',
    sessionId: 's1',
    priorStartedAt: null,
    reservedCredits: 600,
    startedAt: STARTED,
    realtime: true,
    unaffordable: () => new Error('insufficient credits'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    openVoiceHold.mockResolvedValue(true);
    incrementCredits.mockResolvedValue(undefined);
  });

  it('takes the reserve only once the hold is open', async () => {
    expect(await reserveVoiceHold(RESERVE)).toBe(true);

    expect(openVoiceHold).toHaveBeenCalledWith('s1', null, {
      voiceReservedCredits: 600,
      voiceSessionStartedAt: STARTED,
      realtime: true,
    });
    expect(incrementCredits).toHaveBeenCalledWith('u1', -600);
    expect(openVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(incrementCredits.mock.invocationCallOrder[0]);
  });

  it('takes nothing when a concurrent bootstrap opened the hold first', async () => {
    openVoiceHold.mockResolvedValue(false);

    expect(await reserveVoiceHold(RESERVE)).toBe(false);
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it("throws the caller's error when the balance no longer covers the reserve", async () => {
    incrementCredits.mockResolvedValue({ currentCredits: -1 });

    await expect(reserveVoiceHold(RESERVE)).rejects.toThrow('insufficient credits');
  });

  it('opens a hold without touching the balance when credits are not enforced', async () => {
    expect(await reserveVoiceHold({ ...RESERVE, reservedCredits: null })).toBe(true);
    expect(incrementCredits).not.toHaveBeenCalled();
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
    createTransaction.mockImplementation(async (_type: string, row: object) => ({ id: 'tx', ...row }));
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
