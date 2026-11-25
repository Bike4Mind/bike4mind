import { describe, expect, it, vi } from 'vitest';
import {
  FREE_TIER_DAILY_CREDIT_HEADER_NAMES,
  freeTierDailyCreditHeaderValues,
  setFreeTierDailyCreditHeaders,
} from '../freeTierDailyCreditHeaders';

const allowance = { limitCredits: 2500, remainingCredits: 640, resetAt: new Date('2026-11-25T00:00:00.000Z') };

describe('free-tier daily credit headers', () => {
  it('reports the reset as Unix epoch seconds, like the request limiter', () => {
    expect(freeTierDailyCreditHeaderValues(allowance)).toEqual({
      'X-Daily-Credits-Limit': 2500,
      'X-Daily-Credits-Remaining': 640,
      'X-Daily-Credits-Reset': 1795564800,
    });
  });

  it('sets every documented header, and none without an allowance', () => {
    const res = { setHeader: vi.fn() };
    setFreeTierDailyCreditHeaders(res, allowance);
    expect(res.setHeader.mock.calls.map(([name]) => name)).toEqual([...FREE_TIER_DAILY_CREDIT_HEADER_NAMES]);

    res.setHeader.mockClear();
    setFreeTierDailyCreditHeaders(res, undefined);
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
