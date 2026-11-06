import { describe, expect, it } from 'vitest';
import {
  SHADOW_DETECTION_ENFORCE_BAR,
  shadowDetectionSignalTrip,
  shadowDetectionReadiness,
  type ShadowDetectionSummaryRow,
} from './shadowDetection';

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
