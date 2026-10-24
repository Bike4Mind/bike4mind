import { describe, it, expect } from 'vitest';
import { zeroCreditReason } from './zeroCreditModel';

describe('zeroCreditReason', () => {
  it('blames an unverified email for a held starter grant', () => {
    expect(zeroCreditReason({ awaitingVerification: true, personal: true })).toMatch(/verify your email/i);
  });

  it('says the personal balance is spent otherwise', () => {
    expect(zeroCreditReason({ awaitingVerification: false, personal: true })).toBe("You've used all of your credits.");
  });

  it("names the organization when the org's balance is the empty one", () => {
    expect(zeroCreditReason({ awaitingVerification: false, personal: false })).toBe(
      'Your organization has used all of its credits.'
    );
    expect(zeroCreditReason({ awaitingVerification: true, personal: false })).toMatch(/organization/i);
  });
});
