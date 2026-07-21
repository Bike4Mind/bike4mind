import { describe, it, expect } from 'vitest';
import { getQuestErrorCode } from '@bike4mind/common';
import { assertKeySpendWithinCap } from './assertKeySpendWithinCap';

// Settings-free by construction (like assertOwnerHasCredits): no enforceCredits
// input anywhere, so a capped key is refused regardless of the platform toggle.
describe('assertKeySpendWithinCap', () => {
  it('never throws when no cap is configured, at any spend', () => {
    expect(() => assertKeySpendWithinCap({})).not.toThrow();
    expect(() => assertKeySpendWithinCap({ currentSpend: 0 })).not.toThrow();
    expect(() => assertKeySpendWithinCap({ currentSpend: 10_000_000 })).not.toThrow();
  });

  it('passes while spend is under the cap', () => {
    expect(() => assertKeySpendWithinCap({ spendCap: 100, currentSpend: 0 })).not.toThrow();
    expect(() => assertKeySpendWithinCap({ spendCap: 100, currentSpend: 99 })).not.toThrow();
  });

  it('throws at exactly the cap (>= semantics)', () => {
    expect(() => assertKeySpendWithinCap({ spendCap: 100, currentSpend: 100 })).toThrow();
  });

  it('throws over the cap', () => {
    expect(() => assertKeySpendWithinCap({ spendCap: 100, currentSpend: 101 })).toThrow();
  });

  it('treats a cap of 0 as a real cap that blocks all spend (the falsy trap)', () => {
    expect(() => assertKeySpendWithinCap({ spendCap: 0, currentSpend: 0 })).toThrow();
    expect(() => assertKeySpendWithinCap({ spendCap: 0 })).toThrow();
  });

  it('treats an absent currentSpend as zero', () => {
    expect(() => assertKeySpendWithinCap({ spendCap: 1 })).not.toThrow();
  });

  it('throws a 422 tagged spend_cap_exceeded', () => {
    let thrown: unknown;
    try {
      assertKeySpendWithinCap({ spendCap: 5, currentSpend: 5, keyName: 'Acme widget key' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { statusCode?: number }).statusCode).toBe(422);
    expect(getQuestErrorCode(thrown)).toBe('spend_cap_exceeded');
    expect((thrown as Error).message).toContain('Acme widget key');
  });
});
