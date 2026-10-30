import { describe, it, expect, vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({
  partnerSignupRuleRepository: { findActiveRules: vi.fn() },
}));

vi.mock('@client/app/premium-generated/premiumEntitlementGrants.generated', () => ({
  premiumEntitlementGrants: {
    tagGrants: [{ tag: 'example-pro', entitlements: ['example:pro'] }],
    impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
  },
}));

import { assertKnownEntitlements } from './partnerRules';

describe('assertKnownEntitlements with contributed registry rows', () => {
  it('accepts contributed keys, including one that is only implied', () => {
    expect(() => assertKnownEntitlements(['example:pro', 'Example:Addon'])).not.toThrow();
  });

  it('still rejects a mistyped key, naming it', () => {
    expect(() => assertKnownEntitlements(['example:pro', 'example:prp'])).toThrow(
      /Unknown entitlement key\(s\): example:prp\./
    );
  });
});
