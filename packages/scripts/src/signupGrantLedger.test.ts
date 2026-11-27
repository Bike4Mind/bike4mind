import { describe, it, expect } from 'vitest';
import { classifyGrantTransaction } from './signupGrantLedger';

const user = '66a000000000000000000001';
const other = '66a000000000000000000002';

describe('classifyGrantTransaction', () => {
  it('counts the tranche, legacy OTC and unlock payouts as grants', () => {
    expect(classifyGrantTransaction(`verify-grant:${user}`, user)).toBe('grant');
    expect(classifyGrantTransaction(`otc-register-grant:${user}`, user)).toBe('grant');
    expect(classifyGrantTransaction(`unlock-grant:${user}`, user)).toBe('grant');
    expect(classifyGrantTransaction(`unlock-grant:${user}:5000`, user)).toBe('grant');
  });

  it('counts a daily drip payout, with or without a preview period, as a drip', () => {
    expect(classifyGrantTransaction(`unlock-grant:activity:${user}:2026-11-01`, user)).toBe('drip');
    expect(classifyGrantTransaction(`unlock-grant:activity:${user}:2026-11-01:preview:1:2`, user)).toBe('drip');
  });

  it("never counts another user's rows or rows from other credit sources", () => {
    expect(classifyGrantTransaction(`verify-grant:${other}`, user)).toBeNull();
    expect(classifyGrantTransaction(`unlock-grant:activity:${other}:2026-11-01`, user)).toBeNull();
    expect(classifyGrantTransaction(`unlock-grant:${other}:5000`, user)).toBeNull();
    expect(classifyGrantTransaction(`gear-reward:${user}:1`, user)).toBeNull();
    expect(classifyGrantTransaction(`verify-grant:${user}-extra`, user)).toBeNull();
  });
});
