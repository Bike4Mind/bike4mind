import { describe, expect, it } from 'vitest';
import { replaySignupRisk } from './replaySignupRisk';

const policy = {
  enabled: true,
  version: 'synthetic',
  reducedAt: 4,
  reviewAt: 8,
  reducedFraction: 0.5,
  rules: [{ signal: 'ipSignups', comparison: 'gte', threshold: 2, weight: 4, missing: 'review', missingWeight: 0 }],
};

describe('signup risk replay', () => {
  it('reports cohort band counts and missing evidence without outputting observations or policy', () => {
    const sample = (cohort: string, signals: Record<string, unknown>) => ({ cohort, signals, signupCredits: 10 });
    expect(
      replaySignupRisk({
        policy,
        samples: [
          sample('legitimate', { ipSignups: 0 }),
          sample('suspected', { ipSignups: 3 }),
          sample('suspected', {}),
        ],
      })
    ).toEqual({
      legitimate: { samples: 1, full: 1, reduced: 0, review: 0, missingObservations: 0 },
      suspected: { samples: 2, full: 0, reduced: 1, review: 1, missingObservations: 1 },
    });
  });

  it('refuses disabled policies, malformed observations, and unlabeled samples', () => {
    expect(() =>
      replaySignupRisk({
        policy: { enabled: false },
        samples: [{ cohort: 'legitimate', signals: {}, signupCredits: 10 }],
      })
    ).toThrow('enabled policy');
    expect(() => replaySignupRisk({ policy, samples: [{ signals: {}, signupCredits: 10 }] })).toThrow(
      'Invalid replay input'
    );
    expect(() =>
      replaySignupRisk({ policy, samples: [{ cohort: 'legitimate', signals: { arbitrary: true }, signupCredits: 10 }] })
    ).toThrow('Invalid replay input');
  });
});
