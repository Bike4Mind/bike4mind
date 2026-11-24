import { describe, expect, it } from 'vitest';
import {
  ADMIN_ACTION_REASON_MAX_LENGTH,
  AutoContainmentConfigSchema,
  RISK_EVIDENCE_VERSION,
  SHADOW_DETECTION_ACTIONS,
} from '@bike4mind/common';
import { containmentReason, decideContainment, decideIntervention, rolloutBucket } from './policy';

const config = AutoContainmentConfigSchema.parse({});
const featureSummary = {
  evidenceVersion: RISK_EVIDENCE_VERSION,
  detection: {
    detector: 'youngAccountSpend' as const,
    detectorPolicyVersion: 1,
    windowMinutes: 60,
    hostingNetwork: null,
    signals: [],
  },
  accounts: [],
  accountsOmitted: 0,
  group: {
    source: 'linkedAccounts',
    version: 1,
    memberCount: 1,
    memberRefs: ['acct_1'],
    signals: [
      { key: 'sameSignupIpBlockedAccounts', value: 2 },
      { key: 'maxSettlementOverHoldRatio', value: null },
    ],
  },
};
const assessment = {
  id: 'a1',
  result: 'abuse' as const,
  confidence: 0.95,
  model: 'jev-1.13.0' as const,
  featureSummary,
};
const detection = {
  id: 'd1',
  detector: 'youngAccountSpend' as const,
  wouldAction: 'contain' as const,
  userIds: ['u1'],
  verdict: null,
  summary: '9,000 credits in 60 minutes from a 2-hour-old account',
};

describe('decideContainment', () => {
  it.each(['completionSequence', 'completionSynchrony'] as const)(
    'never automatically contains %s evidence, even with a high AI score',
    detector => {
      expect(
        decideContainment({
          assessment: { ...assessment, confidence: 1 },
          detection: { ...detection, detector, wouldAction: 'contain' },
          config: { ...config, mode: 'enforce' },
        })
      ).toEqual({ kind: 'skip', why: 'review_only_detector' });
    }
  );

  it('contains on a confident abuse judgment of an unreviewed containment detection', () => {
    const decision = decideContainment({ assessment, detection, config });
    expect(decision).toMatchObject({ kind: 'contain', userIds: ['u1'] });
  });

  it.each([
    ['mode_off', { config: { ...config, mode: 'off' as const } }],
    ['not_abuse', { assessment: { ...assessment, result: 'insufficient_evidence' as const } }],
    ['below_confidence', { assessment: { ...assessment, confidence: 0.89 } }],
    ['below_confidence', { assessment: { ...assessment, confidence: null } }],
    ['not_a_containment_detection', { detection: { ...detection, wouldAction: 'restrict' as const } }],
    ['already_reviewed', { detection: { ...detection, verdict: 'confirmed_abuse' as const } }],
    ['no_accounts', { detection: { ...detection, userIds: [] } }],
    ['too_many_accounts', { detection: { ...detection, userIds: ['1', '2', '3', '4', '5', '6'] } }],
  ])('skips with %s', (why, override) => {
    expect(decideContainment({ assessment, detection, config, ...override })).toEqual({ kind: 'skip', why });
  });

  it('acts exactly at the confidence threshold and on a suspend detection', () => {
    expect(
      decideContainment({
        assessment: { ...assessment, confidence: 0.9 },
        detection: { ...detection, wouldAction: 'suspend' },
        config,
      }).kind
    ).toBe('contain');
  });
});

describe('containmentReason', () => {
  it('cites the judgment, the detection and the linked-account evidence', () => {
    const reason = containmentReason(assessment, detection);
    expect(reason).toContain('abuse assessment a1 (jev-1.13.0, confidence 0.95)');
    expect(reason).toContain('youngAccountSpend detection d1');
    expect(reason).toContain('sameSignupIpBlockedAccounts=2, maxSettlementOverHoldRatio=unknown');
  });

  it('stays within the admin reason limit', () => {
    const reason = containmentReason(assessment, { ...detection, summary: 'x'.repeat(2_000) });
    expect(reason.length).toBe(ADMIN_ACTION_REASON_MAX_LENGTH);
    expect(reason.endsWith('...')).toBe(true);
  });
});

describe('decideIntervention', () => {
  const NOW = new Date('2026-11-24T10:00:00Z');
  const HOUR_MS = 60 * 60 * 1000;
  const allOn = (mode: 'shadow' | 'enforce' = 'enforce', rolloutPercent = 100) =>
    AutoContainmentConfigSchema.parse({
      mode: 'shadow',
      tiers: Object.fromEntries(
        (['limit', 'verify', 'holdGrant', 'review'] as const).map(tier => [tier, { mode, rolloutPercent }])
      ),
    });
  const fresh = { ...assessment, assessedAt: new Date(NOW.getTime() - HOUR_MS) };
  const decide = (
    over: {
      assessment?: Partial<typeof fresh>;
      detection?: Partial<typeof detection> | { wouldAction: (typeof SHADOW_DETECTION_ACTIONS)[number] };
      config?: ReturnType<typeof allOn>;
      verificationAvailable?: boolean;
    } = {}
  ) =>
    decideIntervention({
      assessment: { ...fresh, ...over.assessment },
      detection: { ...detection, wouldAction: 'restrict', ...over.detection },
      config: over.config ?? allOn(),
      now: NOW,
      verificationAvailable: over.verificationAvailable ?? true,
    });

  it.each([
    ['contain', 'contain'],
    ['suspend', 'contain'],
    ['restrict', 'review'],
    ['confirmHold', 'holdGrant'],
    ['limit', 'limit'],
    ['verify', 'verify'],
    ['blockIp', null],
    ['releaseHold', null],
    ['none', null],
  ] as const)('maps wouldAction %s to tier %s', (wouldAction, tier) => {
    const decision = decide({ detection: { wouldAction } });
    if (tier === null) {
      expect(decision).toEqual({ kind: 'skip', why: 'not_an_intervention_detection', tier: null });
    } else {
      expect(decision).toMatchObject({ kind: 'act', tier });
    }
  });

  it('covers every detection action in the table', () => {
    for (const wouldAction of SHADOW_DETECTION_ACTIONS) {
      expect(decide({ detection: { wouldAction } }).kind).toMatch(/^(act|skip)$/);
    }
  });

  it.each(['limit', 'verify', 'confirmHold', 'restrict'] as const)(
    'honors tier mode off, shadow and enforce for %s',
    wouldAction => {
      expect(decide({ detection: { wouldAction }, config: AutoContainmentConfigSchema.parse({}) })).toMatchObject({
        kind: 'skip',
        why: 'tier_off',
      });
      expect(decide({ detection: { wouldAction }, config: allOn('shadow') })).toMatchObject({ mode: 'shadow' });
      expect(decide({ detection: { wouldAction }, config: allOn('enforce') })).toMatchObject({ mode: 'enforce' });
      expect(decide({ detection: { wouldAction }, config: { ...allOn(), mode: 'off' } })).toMatchObject({
        kind: 'skip',
        why: 'mode_off',
      });
    }
  );

  it('falls back from verify to review when no verification flow is available', () => {
    expect(decide({ detection: { wouldAction: 'verify' }, verificationAvailable: false })).toMatchObject({
      kind: 'act',
      tier: 'review',
    });
  });

  it('keeps unknown, stale and not-abuse evidence apart, and never treats missing evidence as clean', () => {
    expect(decide({ assessment: { result: 'unknown' } })).toMatchObject({ why: 'evidence_unavailable' });
    expect(decide({ assessment: { confidence: null } })).toMatchObject({ why: 'evidence_unavailable' });
    expect(decide({ assessment: { assessedAt: new Date(NOW.getTime() - 25 * HOUR_MS) } })).toMatchObject({
      why: 'stale_evidence',
    });
    expect(decide({ assessment: { result: 'insufficient_evidence' } })).toMatchObject({ why: 'not_abuse' });
    expect(decide({ assessment: { result: 'legitimate_automation' } })).toMatchObject({ why: 'not_abuse' });
  });

  it('bounds evidence age by the tier expiry and rejects an assessment from the future', () => {
    const config = AutoContainmentConfigSchema.parse({
      mode: 'shadow',
      tiers: { review: { mode: 'enforce', rolloutPercent: 100, expiryHours: 2 } },
    });
    const at = (offsetMs: number) => ({ assessedAt: new Date(NOW.getTime() + offsetMs) });
    expect(decide({ config, assessment: at(-3 * HOUR_MS) })).toMatchObject({ why: 'stale_evidence' });
    expect(decide({ config, assessment: at(-HOUR_MS) }).kind).toBe('act');
    expect(decide({ config, assessment: at(10 * 60 * 1000) })).toMatchObject({ why: 'stale_evidence' });
    expect(decide({ config, assessment: at(60 * 1000) }).kind).toBe('act');
  });

  it('acts exactly at the tier threshold and skips just below it', () => {
    expect(decide({ assessment: { confidence: 0.9 } }).kind).toBe('act');
    expect(decide({ assessment: { confidence: 0.89 } })).toMatchObject({ why: 'below_confidence' });
  });

  it.each([
    ['already_reviewed', { verdict: 'legitimate_human' as const }],
    ['no_accounts', { userIds: [] }],
    ['too_many_accounts', { userIds: ['1', '2', '3', '4', '5', '6'] }],
  ])('skips with %s', (why, over) => {
    expect(decide({ detection: over })).toMatchObject({ kind: 'skip', why, tier: 'review' });
  });

  it('dedupes accounts and stamps tier, scope, policy version, expiry and reason', () => {
    const decision = decide({ detection: { wouldAction: 'limit', userIds: ['u1', 'u1'] } });
    expect(decision).toMatchObject({
      kind: 'act',
      tier: 'limit',
      userIds: ['u1'],
      scope: 'ai_spend',
      policyVersion: 1,
      expiresAt: new Date(NOW.getTime() + 72 * HOUR_MS),
    });
    expect(decision.kind === 'act' && decision.reason.startsWith('Automated limit (policy v1): ')).toBe(true);
    expect(decide({ detection: { wouldAction: 'confirmHold' } })).toMatchObject({ scope: 'signup_grant' });
  });

  it('applies rollout per account with a stable bucket', () => {
    expect(decide({ config: allOn('enforce', 0) })).toMatchObject({ kind: 'skip', why: 'not_in_rollout' });
    const ids = Array.from({ length: 40 }, (_, i) => `user-${i}`);
    expect(ids.map(rolloutBucket)).toEqual(ids.map(rolloutBucket));
    const config = AutoContainmentConfigSchema.parse({
      mode: 'shadow',
      maxAccountsPerDetection: 25,
      tiers: { review: { mode: 'enforce', rolloutPercent: 50 } },
    });
    const named = ids.slice(0, 20);
    const decision = decide({ config, detection: { userIds: named } });
    const expected = named.filter(id => rolloutBucket(id) < 50);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(named.length);
    expect(decision).toMatchObject({ kind: 'act', userIds: expected });
  });

  it('decides Contain exactly as decideContainment does, with no expiry', () => {
    const contain = decide({ detection: { wouldAction: 'contain' } });
    expect(contain).toMatchObject({ kind: 'act', tier: 'contain', mode: 'shadow', scope: 'account', expiresAt: null });
    expect(contain.kind === 'act' && contain.reason).toBe(containmentReason(fresh, detection));
    expect(
      decide({ detection: { wouldAction: 'contain' }, assessment: { assessedAt: new Date(0), confidence: 0.95 } }).kind
    ).toBe('act');
  });

  describe('Contain fallback', () => {
    const withLimit = (limit: Record<string, unknown>) =>
      AutoContainmentConfigSchema.parse({ mode: 'shadow', tiers: { limit: { rolloutPercent: 100, ...limit } } });
    const belowContain = { detection: { wouldAction: 'contain' as const }, assessment: { confidence: 0.8 } };

    it('offers an abuse judgment below Contain minConfidence to the limit tier', () => {
      expect(decide({ ...belowContain, config: withLimit({ mode: 'shadow', minConfidence: 0.7 }) })).toMatchObject({
        kind: 'act',
        tier: 'limit',
        mode: 'shadow',
        scope: 'ai_spend',
      });
    });

    it.each([
      ['the tier is off (the default)', { mode: 'off', minConfidence: 0.7 }],
      ['the judgment is below the tier minConfidence too', { mode: 'shadow', minConfidence: 0.85 }],
      ['the account is outside the rollout', { mode: 'shadow', minConfidence: 0.7, rolloutPercent: 0 }],
    ])('keeps the Contain skip when %s', (_label, limit) => {
      expect(decide({ ...belowContain, config: withLimit(limit) })).toEqual({
        kind: 'skip',
        why: 'below_confidence',
        tier: 'contain',
      });
    });

    it('never falls back on a judgment that is not abuse', () => {
      const config = withLimit({ mode: 'shadow', minConfidence: 0.7 });
      expect(
        decide({ ...belowContain, assessment: { confidence: 0.8, result: 'insufficient_evidence' }, config })
      ).toEqual({
        kind: 'skip',
        why: 'not_abuse',
        tier: 'contain',
      });
    });
  });
});
