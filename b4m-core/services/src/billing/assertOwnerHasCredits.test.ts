import { describe, it, expect } from 'vitest';
import { getQuestErrorCode } from '@bike4mind/common';
import { assertOwnerHasCredits } from './assertOwnerHasCredits';

// No admin-settings input anywhere in this suite - that is the point: the gate is
// unconditional by construction (it never reads enforceCredits), so it refuses a
// broke owner regardless of the platform-wide toggle.
describe('assertOwnerHasCredits', () => {
  it('passes when the owner has at least the required credits', () => {
    expect(() => assertOwnerHasCredits({ currentCredits: 5 })).not.toThrow();
    expect(() => assertOwnerHasCredits({ currentCredits: 1 })).not.toThrow();
    expect(() => assertOwnerHasCredits({ currentCredits: 100 }, { requiredCredits: 50 })).not.toThrow();
  });

  it('throws a 422 insufficient_credits when the balance is below the requirement', () => {
    let thrown: unknown;
    try {
      assertOwnerHasCredits({ currentCredits: 0, name: 'Acme' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { statusCode?: number }).statusCode).toBe(422);
    expect(getQuestErrorCode(thrown)).toBe('insufficient_credits');
  });

  it('treats an undefined balance as zero and refuses', () => {
    expect(() => assertOwnerHasCredits({})).toThrow();
    expect(() => assertOwnerHasCredits({ currentCredits: 40 }, { requiredCredits: 50 })).toThrow();
  });

  it('refuses when no billing owner is resolved (null/undefined)', () => {
    expect(() => assertOwnerHasCredits(null)).toThrow();
    expect(() => assertOwnerHasCredits(undefined)).toThrow();
  });
});
