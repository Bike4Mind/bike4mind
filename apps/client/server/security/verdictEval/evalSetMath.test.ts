import { describe, expect, it } from 'vitest';
import type { AbuseEvalExample } from '@bike4mind/database';
import { EVAL_SET_MIN_REVIEWED } from '@client/app/utils/verdictEvalSets';
import {
  campaignKeys,
  exampleLabel,
  gradeEvalSet,
  EVAL_SET_MAX_SHARED_IP_GROUP,
  seededSample,
  sharedIpGroups,
  splitOf,
  toEvalSetDetail,
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

describe('sharedIpGroups', () => {
  it('links accounts sharing a signup IP, up to the group cap', () => {
    const nat = Array.from({ length: EVAL_SET_MAX_SHARED_IP_GROUP + 1 }, (_, n) => ({
      userId: id(100 + n),
      ip: '192.0.2.1',
    }));
    const atCap = Array.from({ length: EVAL_SET_MAX_SHARED_IP_GROUP }, (_, n) => ({
      userId: id(200 + n),
      ip: '192.0.2.2',
    }));
    const groups = sharedIpGroups([
      { userId: id(1), ip: '198.51.100.1' },
      { userId: id(2), ip: '198.51.100.1' },
      { userId: id(3), ip: '198.51.100.2' },
      { userId: id(4), ip: null },
      { userId: id(5), ip: undefined },
      ...nat,
      ...atCap,
    ]);
    expect(groups).toEqual([[id(1), id(2)], atCap.map(user => user.userId)]);
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

  it('maps a set run within a day of its draw to the window it was drawn with', () => {
    const drawnAt = new Date('2026-11-06T00:00:00Z');
    const daysBefore = (days: number) => new Date(drawnAt.getTime() - days * 24 * 60 * 60 * 1000);
    const oneMinuteLater = new Date(drawnAt.getTime() + 60_000);
    const threeDaysLater = new Date(drawnAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(windowCovering(daysBefore(7), oneMinuteLater)).toBe(7);
    expect(windowCovering(daysBefore(30), oneMinuteLater)).toBe(30);
    expect(windowCovering(daysBefore(90), oneMinuteLater)).toBe(90);
    expect(windowCovering(daysBefore(90), threeDaysLater)).toBeNull();
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
    // 3 of 4 flagged ones stand for 3 of the 4 flagged accounts. Their frozen labels are not reviews.
    expect(report.recall).toEqual({
      flaggedExamples: 3,
      flaggedReviewed: 0,
      flaggedAbuse: 0,
      flaggedPopulation: 3,
      unflaggedExamples: 3,
      unflaggedReviewed: 2,
      unflaggedAbuse: 1,
      unflaggedPopulation: 750,
      minimumReviewed: EVAL_SET_MIN_REVIEWED,
      estimatedFlaggedAbuse: null,
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
  const reviewed = (kind: AbuseEvalExample['kind'], from: number) => (count: number, abuse: number) =>
    Array.from({ length: count }, (_, n) =>
      example({
        userId: id(from + n),
        kind,
        signedUpAt: inWindow,
        verdicts: [verdict(n < abuse ? 'confirmed_abuse' : 'legitimate_human')],
      })
    );
  const reviewedFlagged = reviewed('flagged', 1000);
  const reviewedUnflagged = reviewed('unflagged', 2000);

  it('scales the flagged side up past the flagged cap', () => {
    // 30 flagged examples, 15 abuse, drawn from 150 flagged accounts; 30 unflagged, 3 abuse, from 300.
    const report = gradeEvalSet(
      {
        window,
        population: { flagged: 150, unflagged: 300 },
        examples: [...reviewedFlagged(EVAL_SET_MIN_REVIEWED, 15), ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED, 3)],
      },
      noPredictions
    );
    expect(report.recall).toMatchObject({
      flaggedReviewed: EVAL_SET_MIN_REVIEWED,
      flaggedPopulation: 150,
      estimatedFlaggedAbuse: 75,
      unflaggedPopulation: 300,
      estimatedMissedAbuse: 30,
      estimatedRecall: 0.714,
      recallWithheld: null,
    });
  });

  it('counts only evaluation-set verdicts on either side, never frozen labels', () => {
    const frozenFlagged = Array.from({ length: EVAL_SET_MIN_REVIEWED }, (_, n) =>
      example({ userId: id(300 + n), signedUpAt: inWindow, frozenLabel: frozen(n < 10 ? 'abuse' : 'legit') })
    );
    const frozenUnflagged = Array.from({ length: EVAL_SET_MIN_REVIEWED }, (_, n) =>
      example({ userId: id(400 + n), kind: 'unflagged', signedUpAt: inWindow, frozenLabel: frozen('abuse') })
    );
    const flaggedFrozenOnly = gradeEvalSet(
      {
        window,
        population: { flagged: 30, unflagged: 300 },
        examples: [...frozenFlagged, ...reviewedUnflagged(EVAL_SET_MIN_REVIEWED, 3)],
      },
      noPredictions
    );
    expect(flaggedFrozenOnly.recall).toMatchObject({
      flaggedExamples: EVAL_SET_MIN_REVIEWED,
      flaggedReviewed: 0,
      flaggedAbuse: 0,
      estimatedFlaggedAbuse: null,
      estimatedRecall: null,
      recallWithheld: 'too_few_flagged_reviews',
    });
    // Precision still falls back to the frozen labels.
    expect(flaggedFrozenOnly.labelled).toBe(2 * EVAL_SET_MIN_REVIEWED);

    const unflaggedFrozenOnly = gradeEvalSet(
      {
        window,
        population: { flagged: 30, unflagged: 300 },
        examples: [...reviewedFlagged(EVAL_SET_MIN_REVIEWED, 10), ...frozenUnflagged],
      },
      noPredictions
    );
    expect(unflaggedFrozenOnly.recall).toMatchObject({
      unflaggedExamples: EVAL_SET_MIN_REVIEWED,
      unflaggedReviewed: 0,
      unflaggedAbuse: 0,
      estimatedMissedAbuse: null,
      recallWithheld: 'too_few_unflagged_reviews',
    });
    expect(unflaggedFrozenOnly.labelled).toBe(EVAL_SET_MIN_REVIEWED);
  });

  it('withholds recall below the review minimum on either side, unflagged first', () => {
    const grade = (flagged: number, unflagged: number) =>
      gradeEvalSet(
        {
          window,
          population: { flagged, unflagged: 300 },
          examples: [...reviewedFlagged(flagged, 1), ...reviewedUnflagged(unflagged, 1)],
        },
        noPredictions
      ).recall;
    expect(grade(EVAL_SET_MIN_REVIEWED, EVAL_SET_MIN_REVIEWED - 1)).toMatchObject({
      estimatedRecall: null,
      recallWithheld: 'too_few_unflagged_reviews',
    });
    expect(grade(EVAL_SET_MIN_REVIEWED - 1, EVAL_SET_MIN_REVIEWED)).toMatchObject({
      flaggedReviewed: EVAL_SET_MIN_REVIEWED - 1,
      estimatedRecall: null,
      recallWithheld: 'too_few_flagged_reviews',
    });
    expect(grade(EVAL_SET_MIN_REVIEWED - 1, EVAL_SET_MIN_REVIEWED - 1)).toMatchObject({
      recallWithheld: 'too_few_unflagged_reviews',
    });
    expect(grade(EVAL_SET_MIN_REVIEWED, EVAL_SET_MIN_REVIEWED).recallWithheld).toBeNull();
  });

  it('counts only flagged accounts created inside the window', () => {
    const outside = (userId: string, signedUpAt: Date | null) =>
      example({ userId, signedUpAt, verdicts: [verdict('confirmed_abuse')] });
    const report = gradeEvalSet(
      {
        window,
        population: { flagged: 4, unflagged: 300 },
        examples: [
          ...reviewedFlagged(2, 1),
          outside(id(3), new Date('2026-09-01T00:00:00Z')),
          outside(id(4), null),
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

describe('toEvalSetDetail', () => {
  it('counts stored runs that no longer parse instead of dropping them silently', () => {
    const goodRun = gradeEvalSet({ window, population: { flagged: 1, unflagged: 1 }, examples: [] }, noPredictions);
    const set = {
      id: 'set-1',
      name: 'November',
      note: null,
      createdBy: id(99),
      window,
      seed: 'seed',
      heldOutShare: 0.5,
      population: { flagged: 1, unflagged: 1 },
      truncated: false,
      examples: [],
      runs: [
        { ranAt: window.until, ranBy: id(99), note: null, report: { split: 'old shape' } },
        { ranAt: window.until, ranBy: id(99), note: 'ok', report: goodRun },
      ],
      createdAt: window.until,
      updatedAt: window.until,
    };
    const detail = toEvalSetDetail(set);
    expect(detail).toMatchObject({ runCount: 2, unreadableRunCount: 1 });
    expect(detail.runs.map(run => run.note)).toEqual(['ok']);
  });
});
