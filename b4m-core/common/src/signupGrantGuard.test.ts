import { describe, expect, it } from 'vitest';
import { checkSignupGrantSave, isSignupGrantGuardedSaveKey, unprotectedSignupGrantLimit } from './signupGrantGuard';

const enabledPolicy = {
  enabled: true,
  version: 'v1',
  rules: [{ signal: 'datacenter', comparison: 'eq', threshold: 1, weight: 5, missing: 'score', missingWeight: 1 }],
  reducedAt: 3,
  reviewAt: 5,
  reducedFraction: 0.5,
};

const refused = (result: ReturnType<typeof checkSignupGrantSave>) => {
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.reason;
};

describe('unprotectedSignupGrantLimit', () => {
  it('reads a stored limit, including a stored string', () => {
    expect(unprotectedSignupGrantLimit(5000)).toBe(5000);
    expect(unprotectedSignupGrantLimit('0')).toBe(0);
  });

  it('falls back to the registry default when unset or unreadable', () => {
    expect(unprotectedSignupGrantLimit(undefined)).toBe(1000);
    expect(unprotectedSignupGrantLimit(null)).toBe(1000);
    expect(unprotectedSignupGrantLimit(-1)).toBe(1000);
    expect(unprotectedSignupGrantLimit('lots')).toBe(1000);
  });
});

describe('isSignupGrantGuardedSaveKey', () => {
  it('covers the policy and the assessed grants only', () => {
    expect(isSignupGrantGuardedSaveKey('signupGrantRiskPolicy')).toBe(true);
    expect(isSignupGrantGuardedSaveKey('signupGrantInitialCredits')).toBe(true);
    expect(isSignupGrantGuardedSaveKey('signupGrantInviteBonusCredits')).toBe(true);
    expect(isSignupGrantGuardedSaveKey('signupGrantUnprotectedMaxCredits')).toBe(true);
    expect(isSignupGrantGuardedSaveKey('signupGrantDripCap')).toBe(false);
  });
});

describe('checkSignupGrantSave: grant amounts', () => {
  it.each(['signupGrantInitialCredits', 'signupGrantInviteBonusCredits'])(
    'refuses %s above the limit while the policy is off',
    key => {
      const reason = refused(checkSignupGrantSave(key, 1001, { signupGrantRiskPolicy: { enabled: false } }));
      expect(reason).toContain('above 1,000 credits needs a valid, enabled Signup Grant Assessment Policy');
    }
  );

  it('treats an unset policy as off', () => {
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1001, {}).ok).toBe(false);
  });

  it('refuses a large grant while the stored enabled policy is invalid', () => {
    const invalid = { ...enabledPolicy, reviewAt: 1 };
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1001, { signupGrantRiskPolicy: invalid }).ok).toBe(false);
  });

  it('allows a grant at the limit while the policy is off', () => {
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1000, {}).ok).toBe(true);
  });

  it('allows a large grant while a valid policy is enabled, stored as an object or a JSON string', () => {
    expect(checkSignupGrantSave('signupGrantInitialCredits', 50000, { signupGrantRiskPolicy: enabledPolicy }).ok).toBe(
      true
    );
    const stored = { signupGrantRiskPolicy: JSON.stringify(enabledPolicy) };
    expect(checkSignupGrantSave('signupGrantInviteBonusCredits', 50000, stored).ok).toBe(true);
  });

  it('uses the stored limit', () => {
    expect(
      checkSignupGrantSave('signupGrantInitialCredits', 4000, { signupGrantUnprotectedMaxCredits: '5000' }).ok
    ).toBe(true);
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1, { signupGrantUnprotectedMaxCredits: 0 }).ok).toBe(
      false
    );
  });

  it('refuses re-saving an unchanged grant that is already above the limit while the policy is off', () => {
    const current = { signupGrantInitialCredits: '9000', signupGrantRiskPolicy: { enabled: false } };
    expect(checkSignupGrantSave('signupGrantInitialCredits', 9000, current).ok).toBe(false);
  });

  it('refuses a large grant while the stored enabled policy has no weighted rule', () => {
    const unweighted = { ...enabledPolicy, rules: [{ ...enabledPolicy.rules[0], weight: 0 }] };
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1001, { signupGrantRiskPolicy: unweighted }).ok).toBe(
      false
    );
  });

  it('allows lowering one grant while another is still above the limit', () => {
    const current = { signupGrantInitialCredits: '9000', signupGrantRiskPolicy: { enabled: false } };
    expect(checkSignupGrantSave('signupGrantInviteBonusCredits', 0, current).ok).toBe(true);
    expect(checkSignupGrantSave('signupGrantInitialCredits', 500, current).ok).toBe(true);
  });

  it('ignores keys it does not guard', () => {
    expect(checkSignupGrantSave('signupGrantDripCap', 1_000_000, {}).ok).toBe(true);
    expect(checkSignupGrantSave('signupGrantDailyCredits', 1_000_000, {}).ok).toBe(true);
  });
});

describe('checkSignupGrantSave: assessment policy', () => {
  it('refuses turning the policy off while a grant is above the limit, naming each one', () => {
    const reason = refused(
      checkSignupGrantSave(
        'signupGrantRiskPolicy',
        { enabled: false },
        { signupGrantInitialCredits: '2000', signupGrantInviteBonusCredits: 3000 }
      )
    );
    expect(reason).toBe(
      "Signup Grant Assessment Policy can't be turned off while Signup Grant Initial Credits is 2,000 and Signup Grant Invite Bonus Credits is 3,000, above the 1,000 credit Unprotected Signup Grant Limit. Lower the grant first."
    );
  });

  it('allows turning the policy off while every grant is within the limit', () => {
    const current = { signupGrantInitialCredits: 1000, signupGrantInviteBonusCredits: '0' };
    expect(checkSignupGrantSave('signupGrantRiskPolicy', { enabled: false }, current).ok).toBe(true);
  });

  it('allows enabling a valid policy while a grant is above the limit', () => {
    const current = { signupGrantInitialCredits: 9000 };
    expect(checkSignupGrantSave('signupGrantRiskPolicy', enabledPolicy, current).ok).toBe(true);
  });

  it('refuses an invalid policy with the failing field', () => {
    const reason = refused(checkSignupGrantSave('signupGrantRiskPolicy', { ...enabledPolicy, version: '' }, {}));
    expect(reason).toMatch(/^Signup Grant Assessment Policy is not valid\. version: /);
  });

  it('refuses a policy whose bands are out of order', () => {
    const reason = refused(checkSignupGrantSave('signupGrantRiskPolicy', { ...enabledPolicy, reviewAt: 2 }, {}));
    expect(reason).toContain('Bands must be strictly ordered');
  });

  it('refuses unknown fields on a disabled policy', () => {
    expect(checkSignupGrantSave('signupGrantRiskPolicy', { enabled: false, extra: 1 }, {}).ok).toBe(false);
  });

  it('refuses an enabled policy with no rule weighted above 0', () => {
    const unweighted = { ...enabledPolicy, rules: [{ ...enabledPolicy.rules[0], weight: 0, missingWeight: 3 }] };
    const reason = refused(checkSignupGrantSave('signupGrantRiskPolicy', unweighted, {}));
    expect(reason).toBe(
      'Signup Grant Assessment Policy is not valid. An enabled policy needs at least one rule with a weight above 0.'
    );
  });

  it('refuses an enabled policy whose reducedAt the rules can never reach', () => {
    const unreachable = { ...enabledPolicy, reducedAt: 6, reviewAt: 7 };
    const reason = refused(checkSignupGrantSave('signupGrantRiskPolicy', unreachable, {}));
    expect(reason).toBe(
      'Signup Grant Assessment Policy is not valid. reducedAt (6) is above the highest score the rules can reach (5).'
    );
  });

  it("counts a 'score' rule's missingWeight toward the reachable score", () => {
    const viaMissing = { ...enabledPolicy, rules: [{ ...enabledPolicy.rules[0], weight: 1, missingWeight: 4 }] };
    expect(checkSignupGrantSave('signupGrantRiskPolicy', viaMissing, {}).ok).toBe(true);
  });

  it("does not count a 'review' rule's missingWeight toward the reachable score", () => {
    const viaReview = {
      ...enabledPolicy,
      rules: [{ ...enabledPolicy.rules[0], weight: 1, missing: 'review', missingWeight: 4 }],
    };
    expect(checkSignupGrantSave('signupGrantRiskPolicy', viaReview, {}).ok).toBe(false);
  });

  it('refuses a large grant while the stored enabled policy cannot reach reducedAt', () => {
    const unreachable = { ...enabledPolicy, reducedAt: 6, reviewAt: 7 };
    expect(checkSignupGrantSave('signupGrantInitialCredits', 1001, { signupGrantRiskPolicy: unreachable }).ok).toBe(
      false
    );
  });
});

describe('checkSignupGrantSave: unprotected limit', () => {
  it('refuses lowering the limit below a stored grant while the policy is off', () => {
    const reason = refused(
      checkSignupGrantSave('signupGrantUnprotectedMaxCredits', 500, { signupGrantInitialCredits: '800' })
    );
    expect(reason).toBe(
      "Unprotected Signup Grant Limit can't be set to 500 while Signup Grant Initial Credits is 800 and the Signup Grant Assessment Policy is off. Lower the grant or enable the policy first."
    );
  });

  it('allows lowering the limit to a stored grant, or below one while a valid policy is enabled', () => {
    expect(checkSignupGrantSave('signupGrantUnprotectedMaxCredits', 800, { signupGrantInitialCredits: '800' }).ok).toBe(
      true
    );
    const protectedGrant = { signupGrantInitialCredits: '800', signupGrantRiskPolicy: enabledPolicy };
    expect(checkSignupGrantSave('signupGrantUnprotectedMaxCredits', 0, protectedGrant).ok).toBe(true);
  });

  it('allows raising the limit', () => {
    expect(
      checkSignupGrantSave('signupGrantUnprotectedMaxCredits', 50000, { signupGrantInitialCredits: 9000 }).ok
    ).toBe(true);
  });
});
