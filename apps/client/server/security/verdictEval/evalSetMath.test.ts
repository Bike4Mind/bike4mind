import { describe, expect, it } from 'vitest';
import type { AbuseEvalExample } from '@bike4mind/database';
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
  it('links accounts through shared groups, transitively, keyed by the smallest id', () => {
    const keys = campaignKeys(
      [id(3), id(1), id(2), id(9)],
      [
        [id(3), id(7)],
        [id(7), id(2)],
      ]
    );
    expect(keys.get(id(3))).toBe(id(2));
    expect(keys.get(id(2))).toBe(id(2));
    expect(keys.get(id(1))).toBe(id(1));
    expect(keys.get(id(9))).toBe(id(9));
  });

  it('joins two set members through an account outside the set', () => {
    const keys = campaignKeys(
      [id(5), id(6)],
      [
        [id(5), id(1)],
        [id(1), id(6)],
      ]
    );
    expect(keys.get(id(5))).toBe(id(1));
    expect(keys.get(id(6))).toBe(id(1));
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
  it('is null with no trials and below the observed rate otherwise', () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(10, 10)).toBe(0.722);
    expect(wilsonLowerBound(90, 100)).toBe(0.826);
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
});

describe('gradeEvalSet', () => {
  const set = {
    window: { since: new Date('2026-10-07T00:00:00Z'), until: new Date('2026-11-06T00:00:00Z') },
    population: { flagged: 4, unflagged: 1000 },
    examples: [
      example({ userId: id(1), detectionIds: ['d1'], frozenLabel: frozen('abuse'), cohorts: ['mobile'] }),
      example({ userId: id(2), detectionIds: ['d2'], frozenLabel: frozen('legit'), cohorts: ['mobile', 'apiAgent'] }),
      example({ userId: id(3), detectionIds: ['d3'], frozenLabel: frozen('abuse') }),
      example({ userId: id(4), kind: 'unflagged', verdicts: [verdict('confirmed_abuse')] }),
      example({ userId: id(5), kind: 'unflagged', verdicts: [verdict('legitimate_human')] }),
      example({ userId: id(6), kind: 'unflagged' }),
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

  it('estimates recall from the labelled unflagged sample scaled to the held-out population', () => {
    // 3 of 4 unflagged examples are held out, so they stand for 750 of the 1000 unflagged accounts.
    expect(report.recall).toEqual({
      flaggedAbuse: 2,
      sampledUnflaggedAbuse: 1,
      sampledUnflagged: 2,
      unflaggedPopulation: 750,
      estimatedMissedAbuse: 375,
      estimatedRecall: 0.005,
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
    const none = gradeEvalSet(
      { ...set, examples: set.examples.filter(row => row.kind === 'flagged') },
      { assessments: [], decisions: [], signupVerdicts: new Map() }
    );
    expect(none.recall).toMatchObject({ estimatedMissedAbuse: null, estimatedRecall: null });
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
  });
});
