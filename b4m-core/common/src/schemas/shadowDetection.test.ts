import { describe, expect, it } from 'vitest';
import {
  REVERSIBLE_TIER_ENFORCE_BAR,
  SHADOW_DETECTION_ENFORCE_BAR,
  shadowDetectionSignalTrip,
  shadowDetectionReadiness,
  shadowDetectionBulkVerdictResponseSchema,
  type ShadowDetectionSummaryRow,
} from './shadowDetection';

describe('shadowDetectionBulkVerdictResponseSchema', () => {
  it('accepts complete and partial-progress responses and requires the failed ids', () => {
    const complete = { graded: [], conflicts: [], missing: [], failed: [] };
    expect(shadowDetectionBulkVerdictResponseSchema.parse(complete)).toEqual(complete);
    const partial = { ...complete, failed: ['detection-id'] };
    expect(shadowDetectionBulkVerdictResponseSchema.parse(partial)).toEqual(partial);
    const withoutFailed = { graded: [], conflicts: [], missing: [] };
    expect(shadowDetectionBulkVerdictResponseSchema.safeParse(withoutFailed).success).toBe(false);
  });
});

const row = (counts: Partial<ShadowDetectionSummaryRow>): ShadowDetectionSummaryRow => ({
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  recorded: 0,
  noAction: 0,
  confirmedAbuse: 0,
  legitimateHuman: 0,
  legitimateAutomation: 0,
  insufficientEvidence: 0,
  ...counts,
});

describe('shadowDetectionReadiness', () => {
  const { minConclusive } = SHADOW_DETECTION_ENFORCE_BAR;

  it('keeps collecting below the conclusive minimum, whatever the precision', () => {
    expect(shadowDetectionReadiness(row({ confirmedAbuse: minConclusive - 1, insufficientEvidence: 40 }))).toEqual({
      status: 'collecting',
      conclusive: minConclusive - 1,
      precision: 1,
    });
  });

  it('is ready at the minimum with precision at or above the floor', () => {
    const falsePositives = Math.floor(minConclusive * (1 - SHADOW_DETECTION_ENFORCE_BAR.minPrecision));
    const readiness = shadowDetectionReadiness(
      row({ confirmedAbuse: minConclusive - falsePositives, legitimateHuman: falsePositives })
    );
    expect(readiness.status).toBe('ready');
    expect(readiness.conclusive).toBe(minConclusive);
  });

  it('is below the bar with enough verdicts but too many false positives', () => {
    expect(
      shadowDetectionReadiness(row({ confirmedAbuse: minConclusive, legitimateHuman: 5, legitimateAutomation: 5 }))
        .status
    ).toBe('below_bar');
  });
});

describe('shadowDetectionReadiness against the reversible-tier bar', () => {
  it('sits below the Contain bar', () => {
    expect(REVERSIBLE_TIER_ENFORCE_BAR.minConclusive).toBeLessThan(SHADOW_DETECTION_ENFORCE_BAR.minConclusive);
    expect(REVERSIBLE_TIER_ENFORCE_BAR.minPrecision).toBeLessThan(SHADOW_DETECTION_ENFORCE_BAR.minPrecision);
  });

  it('is ready for the reversible tiers while still collecting for Contain', () => {
    const graded = row({ confirmedAbuse: 19, legitimateHuman: 1 });
    expect(shadowDetectionReadiness(graded, REVERSIBLE_TIER_ENFORCE_BAR)).toEqual({
      status: 'ready',
      conclusive: 20,
      precision: 0.95,
    });
    expect(shadowDetectionReadiness(graded).status).toBe('collecting');
  });

  it('is below the reversible bar under its precision floor', () => {
    const graded = row({ confirmedAbuse: 17, legitimateHuman: 3 });
    expect(shadowDetectionReadiness(graded, REVERSIBLE_TIER_ENFORCE_BAR).status).toBe('below_bar');
  });
});

describe('shadowDetectionSignalTrip', () => {
  const signal = (key: string, observed: number | null, threshold: number | null) => ({
    key,
    label: key,
    observed,
    threshold,
  });

  it.each([
    ['ipSignups', 3, 2, 'above'],
    ['ipSignups', 2, 2, null],
    ['youngAccount', 12, 60, 'below'],
    ['youngAccount', 90, 60, null],
    ['blockedSignupIpLinks', 1, 1, 'atLeast'],
    ['hoursToBlockedLink', 72, 72, 'atMost'],
    ['hoursToBlockedLink', 73, 72, null],
  ] as const)('%s observed %s against %s trips as %s', (key, observed, threshold, expected) => {
    expect(shadowDetectionSignalTrip(signal(key, observed, threshold))).toBe(expected);
  });

  it('never trips a signal with no known rule or no numbers', () => {
    expect(shadowDetectionSignalTrip(signal('accountCredits', 500, 100))).toBeNull();
    expect(shadowDetectionSignalTrip(signal('ipSignups', null, 2))).toBeNull();
    expect(shadowDetectionSignalTrip(signal('hostingNetwork', null, null))).toBeNull();
  });
});
