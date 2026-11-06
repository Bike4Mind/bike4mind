import { describe, expect, it } from 'vitest';
import { ADMIN_ACTION_REASON_MAX_LENGTH, AutoContainmentConfigSchema, RISK_EVIDENCE_VERSION } from '@bike4mind/common';
import { containmentReason, decideContainment } from './policy';

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
