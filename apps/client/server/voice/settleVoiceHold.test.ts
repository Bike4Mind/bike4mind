import { beforeEach, describe, expect, it, vi } from 'vitest';

const { claimVoiceHold, incrementCredits } = vi.hoisted(() => ({ claimVoiceHold: vi.fn(), incrementCredits: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { claimVoiceHold },
  userRepository: { incrementCredits },
}));

import { settleVoiceHold } from './settleVoiceHold';
import { MAX_SESSION_SECONDS } from './voiceSessionLimits';

const STARTED = new Date('2026-10-11T12:00:00Z');
const HOLD = { id: 's1', userId: 'u1', voiceReservedCredits: 600, voiceSessionStartedAt: STARTED };

describe('settleVoiceHold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimVoiceHold.mockResolvedValue(true);
  });

  it('claims the hold, then refunds what the elapsed time does not owe', async () => {
    const result = await settleVoiceHold(HOLD, MAX_SESSION_SECONDS / 3);

    expect(result).toEqual({ settled: true, owed: 200, refund: 400 });
    expect(claimVoiceHold).toHaveBeenCalledWith('s1', STARTED);
    expect(incrementCredits).toHaveBeenCalledWith('u1', 400);
    expect(claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(incrementCredits.mock.invocationCallOrder[0]);
  });

  it('refunds the whole hold for a call with no elapsed time', async () => {
    expect(await settleVoiceHold(HOLD, 0)).toEqual({ settled: true, owed: 0, refund: 600 });
  });

  it('keeps the whole hold, and refunds nothing, past the longest call', async () => {
    expect(await settleVoiceHold(HOLD, MAX_SESSION_SECONDS * 2)).toEqual({ settled: true, owed: 600, refund: 0 });
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('moves no credits when another settler claimed the hold first', async () => {
    claimVoiceHold.mockResolvedValue(false);

    expect(await settleVoiceHold(HOLD, 0)).toEqual({ settled: false });
    expect(incrementCredits).not.toHaveBeenCalled();
  });
});
