import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import {
  assessSignupGrant,
  evaluateSignupRisk,
  isSignupGrantHeldForReview,
  signupRiskPolicySchema,
  type SignupRiskAdapters,
} from './signupRisk';

const policy = {
  enabled: true as const,
  version: 'synthetic',
  rules: [
    {
      signal: 'ipSignups' as const,
      comparison: 'gte' as const,
      threshold: 3,
      weight: 4,
      missing: 'review' as const,
      missingWeight: 0,
    },
  ],
  reducedAt: 4,
  reviewAt: 8,
  reducedFraction: 0.5,
};

describe('evaluateSignupRisk', () => {
  it('maps synthetic observations to full, reduced and review with inclusive boundaries', () => {
    expect(evaluateSignupRisk(policy, { ipSignups: 2 }, 11)).toMatchObject({ band: 'full', credits: 11, score: 0 });
    expect(evaluateSignupRisk(policy, { ipSignups: 3 }, 11)).toMatchObject({ band: 'reduced', credits: 5, score: 4 });
    expect(
      evaluateSignupRisk(
        { ...policy, reviewAt: 4.5, reducedAt: 2, rules: [{ ...policy.rules[0], weight: 4.5 }] },
        { ipSignups: 3 },
        11
      )
    ).toMatchObject({ band: 'review', credits: 0, score: 4.5 });
  });

  it('keeps missing distinct from known absence and confirmed risk', () => {
    expect(evaluateSignupRisk(policy, {}, 10)).toMatchObject({ band: 'review', missing: ['ipSignups'], reasons: [] });
    expect(evaluateSignupRisk(policy, { ipSignups: 0 }, 10)).toMatchObject({ band: 'full', missing: [], reasons: [] });
    const missingPolicy = { ...policy, rules: [{ ...policy.rules[0], missing: 'score', missingWeight: 4 }] };
    expect(evaluateSignupRisk(missingPolicy, {}, 10)).toMatchObject({ band: 'reduced', score: 4 });
  });

  it.each([NaN, Infinity, -1, 0.5, true, null])('treats malformed count %s as unavailable', value => {
    expect(evaluateSignupRisk(policy, { ipSignups: value }, 10).band).toBe('review');
  });

  it.each(['datacenter', 'canonicalEmailCollision', 'disposableDomain', 'blockedDomain', 'challengeVerified'] as const)(
    'accepts only boolean observations for %s',
    signal => {
      const booleanPolicy = {
        ...policy,
        rules: [{ ...policy.rules[0], signal, comparison: 'eq', threshold: 1 }],
      };
      expect(evaluateSignupRisk(booleanPolicy, { [signal]: false }, 10).band).toBe('full');
      expect(evaluateSignupRisk(booleanPolicy, { [signal]: true }, 10).band).toBe('reduced');
      expect(evaluateSignupRisk(booleanPolicy, { [signal]: 0 }, 10).band).toBe('review');
    }
  );

  it('accumulates independent signals before choosing the review band', () => {
    const combinedPolicy = {
      ...policy,
      rules: [...policy.rules, { ...policy.rules[0], signal: 'asnSignups' }],
    };
    expect(evaluateSignupRisk(combinedPolicy, { ipSignups: 3, asnSignups: 3 }, 11)).toMatchObject({
      band: 'review',
      credits: 0,
      score: 8,
      reasons: ['ipSignups', 'asnSignups'],
    });
  });

  it('can match a known false boolean without treating missing as false', () => {
    const challengePolicy = {
      ...policy,
      rules: [{ ...policy.rules[0], signal: 'challengeVerified', comparison: 'eq', threshold: 0 }],
    };
    expect(evaluateSignupRisk(challengePolicy, { challengeVerified: true }, 10).band).toBe('full');
    expect(evaluateSignupRisk(challengePolicy, { challengeVerified: false }, 10).band).toBe('reduced');
    expect(evaluateSignupRisk(challengePolicy, {}, 10).band).toBe('review');
  });

  it.each([
    undefined,
    {},
    { ...policy, reducedAt: NaN },
    { ...policy, reviewAt: Infinity },
    { ...policy, reviewAt: policy.reducedAt },
    { ...policy, reducedFraction: 1 },
    { ...policy, rules: [] },
    { ...policy, rules: [...policy.rules, ...policy.rules] },
    { ...policy, rules: [{ ...policy.rules[0], weight: -1 }] },
    { ...policy, rules: [{ ...policy.rules[0], signal: 'accountAge' }] },
    { ...policy, rules: [{ ...policy.rules[0], signal: 'datacenter', comparison: 'eq', threshold: 2 }] },
    { ...policy, rules: [{ ...policy.rules[0], signal: 'datacenter', threshold: 1 }] },
    { ...policy, rules: [{ ...policy.rules[0], threshold: 1.5 }] },
    { enabled: false, unexpected: true },
  ])('holds invalid or unconfigured policy without a full-grant fallback', raw => {
    expect(signupRiskPolicySchema.safeParse(raw).success).toBe(false);
    expect(evaluateSignupRisk(raw, { ipSignups: 0 }, 10)).toMatchObject({
      credits: 0,
      band: 'review',
      status: 'unavailable',
    });
  });

  it('requires explicit disablement to preserve the configured tranche', () => {
    expect(evaluateSignupRisk({ enabled: false }, {}, 10)).toMatchObject({ credits: 10, status: 'disabled' });
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid entitlement %s', amount => {
    expect(() => evaluateSignupRisk(policy, {}, amount)).toThrow('Invalid signup entitlement');
  });

  it('never exceeds the configured tranche, including zero and numeric limits', () => {
    for (const amount of [0, 1, 101, Number.MAX_SAFE_INTEGER]) {
      const decision = evaluateSignupRisk(policy, { ipSignups: 3 }, amount);
      expect(Number.isSafeInteger(decision.credits)).toBe(true);
      expect(decision.credits).toBeGreaterThanOrEqual(0);
      expect(decision.credits).toBeLessThanOrEqual(amount);
    }
  });
});

describe('assessSignupGrant', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const adaptersFor = (): SignupRiskAdapters => ({
    readPolicy: vi.fn(async () => policy),
    collectSignals: vi.fn(async () => ({ ipSignups: 3 })),
    commit: vi.fn(async decision => ({ decision, applied: true })),
    emitBand: vi.fn(async () => undefined),
  });

  it('passes only the bounded decision to the atomic owner and emits only the band', async () => {
    const adapters = adaptersFor();
    expect(await assessSignupGrant(11, adapters)).toMatchObject({ decision: { credits: 5 }, applied: true });
    expect(adapters.commit).toHaveBeenCalledExactlyOnceWith(evaluateSignupRisk(policy, { ipSignups: 3 }, 11));
    expect(adapters.emitBand).toHaveBeenCalledExactlyOnceWith('reduced');
  });

  it.each(['readPolicy', 'collectSignals'] as const)('holds on %s failures', async method => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapters = adaptersFor();
    vi.mocked(adapters[method]).mockRejectedValue(new Error('unavailable'));
    expect(await assessSignupGrant(11, adapters)).toMatchObject({ decision: { credits: 0, status: 'unavailable' } });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[signup-risk] Assessment unavailable; holding signup grant');
  });

  it('reports invalid policy and skips collection without logging policy contents', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapters = adaptersFor();
    vi.mocked(adapters.readPolicy).mockResolvedValue({ enabled: true, version: 'invalid' });
    await expect(assessSignupGrant(11, adapters)).resolves.toMatchObject({ decision: { credits: 0 } });
    expect(adapters.collectSignals).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith('[signup-risk] Assessment unavailable; holding signup grant');
  });

  it('does not collect signals when explicitly disabled', async () => {
    const adapters = adaptersFor();
    vi.mocked(adapters.readPolicy).mockResolvedValue({ enabled: false });
    await assessSignupGrant(11, adapters);
    expect(adapters.collectSignals).not.toHaveBeenCalled();
  });

  it('uses the stored winning decision on retry and does not emit a second counter', async () => {
    const adapters = adaptersFor();
    const winner = evaluateSignupRisk(policy, { ipSignups: 0 }, 11);
    vi.mocked(adapters.commit).mockResolvedValue({ decision: winner, applied: false });
    expect(await assessSignupGrant(11, adapters)).toEqual({ decision: winner, applied: false });
    expect(adapters.emitBand).not.toHaveBeenCalled();
  });

  it('propagates atomic commit failures without emitting, but ignores metric failure after commit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapters = adaptersFor();
    vi.mocked(adapters.commit).mockRejectedValueOnce(new Error('commit failed'));
    await expect(assessSignupGrant(11, adapters)).rejects.toThrow('commit failed');
    expect(adapters.emitBand).not.toHaveBeenCalled();
    vi.mocked(adapters.emitBand).mockRejectedValue(new Error('metric failed'));
    await expect(assessSignupGrant(11, adapters)).resolves.toMatchObject({ applied: true });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[signup-risk] Band telemetry failed after grant commit');
  });

  it('keeps a committed grant successful when the telemetry adapter throws synchronously', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapters = adaptersFor();
    vi.mocked(adapters.emitBand).mockImplementation(() => {
      throw new Error('synchronous telemetry failure');
    });
    await expect(assessSignupGrant(11, adapters)).resolves.toMatchObject({ applied: true });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[signup-risk] Band telemetry failed after grant commit');
  });
});

describe('isSignupGrantHeldForReview', () => {
  type GrantFields = Pick<IUserDocument, 'signupGrant' | 'signupGrantAssessment'>;
  const held = (band: string, stage: string, creditsReleased: number, status = 'evaluated') =>
    ({
      signupGrant: { stage, signupCredits: 500, unlockCredits: 500, creditsReleased, nextCondition: null },
      signupGrantAssessment: { band, status },
    }) as unknown as GrantFields;

  it('holds an unpaid tranche assessed into the review band', () => {
    expect(isSignupGrantHeldForReview(held('review', 'signup', 0))).toBe(true);
    expect(isSignupGrantHeldForReview(held('review', 'signup', 100))).toBe(true);
  });

  it('does not hold other bands, a paid tranche, or a tranche still waiting on email', () => {
    expect(isSignupGrantHeldForReview(held('reduced', 'signup', 0))).toBe(false);
    expect(isSignupGrantHeldForReview(held('review', 'signup', 500))).toBe(false);
    expect(isSignupGrantHeldForReview(held('review', 'pending_email', 0))).toBe(false);
    expect(isSignupGrantHeldForReview({})).toBe(false);
  });

  it('does not hold a review-band assessment whose policy was unavailable', () => {
    expect(isSignupGrantHeldForReview(held('review', 'signup', 0, 'unavailable'))).toBe(false);
  });
});
