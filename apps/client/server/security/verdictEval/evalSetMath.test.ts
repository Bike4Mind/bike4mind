import { describe, expect, it } from 'vitest';
import type { AbuseEvalExample } from '@bike4mind/database';
import { EVAL_SET_MIN_REVIEWED } from '@client/app/utils/verdictEvalSets';
import {
  campaignKeys,
  exampleLabel,
  gradeEvalSet,
  seededSample,
  splitOf,
  toEvalSetExample,
  wilsonLowerBound,
  windowCovering,
} from './evalSetMath';

const id = (n: number) => n.toString(16).padStart(24, '0');

describe('campaignKeys', () => {
  it('links accounts through shared groups, transitively', () => {
    const keys = campaignKeys(
      'seed',
      [id(3), id(1), id(2), id(9)],
      [
        [id(3), id(7)],
        [id(7), id(2)],
      ]
    );
    expect(keys.get(id(3))).toBe(keys.get(id(2)));
    expect(new Set([keys.get(id(2)), keys.get(id(1)), keys.get(id(9))]).size).toBe(3);
  });

  it('joins two set members through an account outside the set', () => {
    const keys = campaignKeys(
      'seed',
      [id(5), id(6)],
      [
        [id(5), id(1)],
        [id(1), id(6)],
      ]
    );
    expect(keys.get(id(5))).toBe(keys.get(id(6)));
  });

  it('keys a campaign by an opaque hash that is stable per seed and never an account id', () => {
    const userIds = [id(1), id(2), id(3)];
    const keys = campaignKeys('seed', userIds, [[id(1), id(2)]]);
    for (const key of keys.values()) {
      expect(key).toMatch(/^[0-9a-f]{16}$/);
      expect(userIds).not.toContain(key);
    }
    expect(campaignKeys('seed', userIds, [[id(1), id(2)]])).toEqual(keys);
    expect(campaignKeys('other', userIds, [[id(1), id(2)]]).get(id(1))).not.toBe(keys.get(id(1)));
  });
});

describe('splitOf', () => {
  it('is stable per seed and key, and honours the extremes', () => {
    expect(splitOf('s', 'k', 0.5)).toBe(splitOf('s', 'k', 0.5));
    expect(splitOf('s', 'k', 1.1)).toBe('heldOut');
    expect(splitOf('s', 'k', 0)).toBe('tuning');
  });

  it('puts roughly the requested share of campaigns in the held-out half', () => {
    const heldOut = Array.from({ length: 1000 }, (_, n) => splitOf('seed', id(n), 0.3)).filter(
      split => split === 'heldOut'
    ).length;
    expect(heldOut).toBeGreaterThan(240);
    expect(heldOut).toBeLessThan(360);
  });
});

describe('seededSample', () => {
  const ids = Array.from({ length: 50 }, (_, n) => id(n));
  it('is reproducible, ignores input order and differs by seed', () => {
    const sample = seededSample(ids, 'a', 10);
    expect(sample).toHaveLength(10);
    expect(seededSample([...ids].reverse(), 'a', 10)).toEqual(sample);
    expect(seededSample(ids, 'b', 10)).not.toEqual(sample);
  });
});

describe('wilsonLowerBound', () => {
  it('is null with no trials and below the observed rate otherwise, floored to three places', () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(10, 10)).toBe(0.722);
    // 0.82564...: rounding would overstate it as 0.826.
    expect(wilsonLowerBound(90, 100)).toBe(0.825);
    expect(wilsonLowerBound(0, 5)).toBe(0);
  });
});

describe('windowCovering', () => {
  it('picks the smallest report window that reaches the set start', () => {
    const now = new Date('2026-11-06T00:00:00Z');
    expect(windowCovering(new Date('2026-11-01T00:00:00Z'), now)).toBe(7);
    expect(windowCovering(new Date('2026-10-10T00:00:00Z'), now)).toBe(30);
    expect(windowCovering(new Date('2026-09-01T00:00:00Z'), now)).toBe(90);
    expect(windowCovering(new Date('2026-06-01T00:00:00Z'), now)).toBeNull();
  });
});

const example = (overrides: Partial<AbuseEvalExample> & { userId: string }): AbuseEvalExample => ({
  kind: 'flagged',
  detectionIds: [],
  campaignKey: overrides.userId,
  split: 'heldOut',
  cohorts: [],
  signedUpAt: null,
  frozenLabel: null,
  verdicts: [],
  revision: 0,
  ...overrides,
});
const verdict = (value: AbuseEvalExample['verdicts'][number]['verdict']) => ({
  verdict: value,
  reason: 'r',
  reviewerId: id(99),
  reviewedAt: new Date('2026-11-01T00:00:00Z'),
});
const frozen = (label: 'abuse' | 'legit') => ({ label, source: 'adminVerdict' });

describe('exampleLabel', () => {
  it('lets the latest verdict override the frozen label, and insufficient evidence unlabel it', () => {
    const base = example({ userId: id(1), frozenLabel: frozen('abuse') });
    expect(exampleLabel(base)).toEqual({ label: 'abuse', source: 'adminVerdict' });
    expect(exampleLabel({ ...base, verdicts: [verdict('legitimate_human')] })).toEqual({
      label: 'legit',
      source: 'adminVerdict',
    });
    expect(
      exampleLabel({ ...base, verdicts: [verdict('legitimate_human'), verdict('insufficient_evidence')] })
    ).toBeNull();
    expect(exampleLabel(example({ userId: id(2) }))).toBeNull();
  });

  it('never gives an unflagged example its frozen label', () => {
    const unflagged = example({ userId: id(1), kind: 'unflagged', frozenLabel: frozen('abuse') });
    expect(exampleLabel(unflagged)).toBeNull();
    expect(exampleLabel({ ...unflagged, verdicts: [verdict('confirmed_abuse')] })).toEqual({
      label: 'abuse',
      source: 'adminVerdict',
    });
  });
});

const window = { since: new Date('2026-10-07T00:00:00Z'), until: new Date('2026-11-06T00:00:00Z') };
const inWindow = new Date('2026-10-20T00:00:00Z');
const noPredictions = { assessments: [], decisions: [], signupVerdicts: new Map() };

describe('gradeEvalSet', () => {
  const set = {
    window,
    population: { flagged: 4, unflagged: 1000 },
    examples: [
      example({
        userId: id(1),
        detectionIds: ['d1'],
        frozenLabel: frozen('abuse'),
        cohorts: ['mobile'],
        signedUpAt: inWindow,
      }),
      example({
        userId: id(2),
        detectionIds: ['d2'],
        frozenLabel: frozen('legit'),
        cohorts: ['mobile', 'apiAgent'],
        signedUpAt: inWindow,
      }),
      example({ userId: id(3), detectionIds: ['d3'], frozenLabel: frozen('abuse'), signedUpAt: inWindow }),
      example({ userId: id(4), kind: 'unflagged', verdicts: [verdict('confirmed_abuse')] }),
      example({ userId: id(5), kind: 'unflagged', verdicts: [verdict('legitimate_human')] }),
      // A frozen label on an unflagged example never counts.
      example({ userId: id(6), kind: 'unflagged', frozenLabel: frozen('abuse') }),
      example({ userId: id(7), kind: 'unflagged', split: 'tuning', verdicts: [verdict('confirmed_abuse')] }),
      example({ userId: id(8), detectionIds: ['d8'], split: 'tuning', frozenLabel: frozen('abuse') }),
    ],
  };
  const assessment = (detectionId: string, result: 'abuse' | 'legitimate_automation' | 'insufficient_evidence') => ({
    detectionId,
    result,
    confidence: 0.9,
    model: 'm1',
    assessedAt: new Date('2026-11-01T00:00:00Z'),
  });
  const report = gradeEvalSet(set, {
    assessments: [assessment('d1', 'abuse'), assessment('d2', 'abuse'), assessment('d3', 'insufficient_evidence')],
    decisions: [],
    signupVerdicts: new Map([[id(1), 'suspected' as const]]),
  });
  const score = (grader: string) => report.scores.find(row => row.grader === grader);

  it('grades the held-out half only', () => {
    expect(report).toMatchObject({ split: 'heldOut', examples: 6, labelled: 5 });
    expect(report.labelSources).toEqual({ adminVerdict: 5 });
  });

  it('scores detectors on flagged versus unflagged, with a lower bound on precision', () => {
    expect(score('detectors')).toMatchObject({
      variant: 'any',
      truePositive: 2,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 1,
      precision: 0.667,
      precisionLowerBound: wilsonLowerBound(2, 3),
    });
  });

  it('reports no hit rate or false positive rate on any set score', () => {
    expect(report.scores.length).toBeGreaterThan(0);
    for (const row of report.scores) {
      expect(row.hitRate).toBeNull();
      expect(row.falsePositiveRate).toBeNull();
    }
  });

  it('counts unflagged examples as negatives and a missing prediction as an abstention', () => {
    expect(score('assessment')).toMatchObject({
      variant: 'm1',
      truePositive: 1,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 1,
      abstained: 1,
    });
    expect(score('signupVerdict')).toMatchObject({ truePositive: 1, abstained: 4 });
  });

  it('scales both sides to their populations and withholds recall below the review minimum', () => {
    // 3 of 4 unflagged examples are held out, so they stand for 750 of the 1000 unflagged accounts;
    // 3 of 4 flagged ones stand for 3 of the 4 flagged accounts.
    expect(report.recall).toEqual({
      flaggedExamples: 3,
      flaggedReviewed: 3,
      flaggedAbuse: 2,
      flaggedPopulation: 3,
      unflaggedExamples: 3,
      unflaggedReviewed: 2,
      unflaggedAbuse: 1,
      unflaggedPopulation: 750,
      minimumReviewed: EVAL_SET_MIN_REVIEWED,
      estimatedFlaggedAbuse: 2,
      estimatedMissedAbuse: 375,
      estimatedRecall: null,
      recallWithheld: 'too_few_unflagged_reviews',
    });
  });

  it('reports cohorts over the flagged held-out accounts', () => {
    expect(report.cohorts.find(row => row.cohort === 'mobile')).toMatchObject({
      flaggedAccounts: 2,
      labelledAccounts: 2,
      abuse: 1,
      legit: 1,
      falsePositiveShare: 0.5,
    });
  });

  it('has no recall estimate before any unflagged example is labelled', () => {
    const none = gradeEvalSet({ ...set, examples: set.examples.filter(row => row.kind === 'flagged') }, noPredictions);
    expect(none.recall).toMatchObject({ estimatedMissedAbuse: null, estimatedRecall: null });
  });
});

describe('gradeEvalSet recall', () => {
  const reviewedUnflagged = (count: number, abuse: number) =>
    Array.from({ length: count }, (_, n) =>
      example({
        userId: id(100 + n),
        kind: 'unflagged',
        signedUpAt: inWindow,
        verdicts: [verdict(n < abuse ? 'confirmed_abuse' : 'legitimate_human')],
      })
    );
  const flaggedPair = [
    example({ userId: id(1), signedUpAt: inWindow, frozenLabel: frozen('abuse') }),
    example({ userId: id(2), signedUpAt: inWindow, frozenLabel: frozen('legit') }),
  ];

  it('scales the flagged side up past the flagged cap', () => {
    // 2 flagged examples drawn from 10 flagged accounts; 30 unflagged reviewed, 3 abuse, from 300.
    const report = gradeEvalSet(
      {
        window,
        population: { flagged: 10, unflagged: 300 },
        examples: [...flaggedPair, ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED, 3)],
      },
      noPredictions
    );
    expect(report.recall).toMatchObject({
      flaggedPopulation: 10,
      estimatedFlaggedAbuse: 5,
      unflaggedPopulation: 300,
      estimatedMissedAbuse: 30,
      estimatedRecall: 0.143,
      recallWithheld: null,
    });
  });

  it('ignores frozen labels on unflagged examples in the estimate', () => {
    const frozenOnly = Array.from({ length: EVAL_SET_MIN_REVIEWED }, (_, n) =>
      example({ userId: id(200 + n), kind: 'unflagged', signedUpAt: inWindow, frozenLabel: frozen('abuse') })
    );
    const report = gradeEvalSet(
      { window, population: { flagged: 2, unflagged: 300 }, examples: [...flaggedPair, ...frozenOnly] },
      noPredictions
    );
    expect(report.recall).toMatchObject({
      unflaggedExamples: EVAL_SET_MIN_REVIEWED,
      unflaggedReviewed: 0,
      unflaggedAbuse: 0,
      estimatedMissedAbuse: null,
      recallWithheld: 'too_few_unflagged_reviews',
    });
    expect(report.labelled).toBe(2);
  });

  it('withholds recall with too few unflagged reviews or no flagged review', () => {
    const tooFew = gradeEvalSet(
      {
        window,
        population: { flagged: 2, unflagged: 300 },
        examples: [...flaggedPair, ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED - 1, 1)],
      },
      noPredictions
    );
    expect(tooFew.recall).toMatchObject({ estimatedRecall: null, recallWithheld: 'too_few_unflagged_reviews' });

    const noFlagged = gradeEvalSet(
      {
        window,
        population: { flagged: 1, unflagged: 300 },
        examples: [example({ userId: id(1), signedUpAt: inWindow }), ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED, 1)],
      },
      noPredictions
    );
    expect(noFlagged.recall).toMatchObject({
      flaggedReviewed: 0,
      estimatedFlaggedAbuse: null,
      estimatedRecall: null,
      recallWithheld: 'no_flagged_reviews',
    });
  });

  it('counts only flagged accounts created inside the window', () => {
    const report = gradeEvalSet(
      {
        window,
        population: { flagged: 4, unflagged: 300 },
        examples: [
          ...flaggedPair,
          example({ userId: id(3), signedUpAt: new Date('2026-09-01T00:00:00Z'), frozenLabel: frozen('abuse') }),
          example({ userId: id(4), signedUpAt: null, frozenLabel: frozen('abuse') }),
          ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED, 3),
        ],
      },
      noPredictions
    );
    // 2 of the 4 drawn flagged examples are in the window, so they stand for 2 of the 4 flagged accounts.
    expect(report.recall).toMatchObject({
      flaggedExamples: 2,
      flaggedReviewed: 2,
      flaggedAbuse: 1,
      flaggedPopulation: 2,
      estimatedFlaggedAbuse: 1,
    });
  });
});

describe('toEvalSetExample', () => {
  it('names where the label came from and keeps only known cohorts', () => {
    const base = example({ userId: id(1), frozenLabel: frozen('abuse'), cohorts: ['mobile', 'bogus'] });
    expect(toEvalSetExample(base)).toMatchObject({
      currentLabel: { label: 'abuse', source: 'frozen' },
      cohorts: ['mobile'],
    });
    expect(toEvalSetExample({ ...base, verdicts: [verdict('legitimate_human')] })).toMatchObject({
      currentLabel: { label: 'legit', source: 'verdict' },
      latestVerdict: { verdict: 'legitimate_human' },
    });
    expect(toEvalSetExample({ ...base, kind: 'unflagged' }).currentLabel).toBeNull();
  });
});
