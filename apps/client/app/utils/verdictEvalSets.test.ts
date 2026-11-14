import { describe, expect, it } from 'vitest';
import {
  compareEvalSetRuns,
  evalSetRunReportSchema,
  riskReviewShare,
  type EvalSetCalibration,
  type EvalSetRunReport,
  type EvalSetScore,
} from './verdictEvalSets';

describe('riskReviewShare', () => {
  it('is the risk-review share of all labels', () => {
    expect(riskReviewShare({ adminVerdict: 6, riskReview: 2 })).toEqual({ count: 2, total: 8, share: 0.25 });
    expect(riskReviewShare({ riskReview: 3 })).toEqual({ count: 3, total: 3, share: 1 });
  });

  it('is null without risk-review labels', () => {
    expect(riskReviewShare({})).toBeNull();
    expect(riskReviewShare({ adminVerdict: 4, riskReview: 0 })).toBeNull();
  });
});

const score = (variant: string, overrides: Partial<EvalSetScore> = {}): EvalSetScore => ({
  grader: 'assessment',
  variant,
  truePositive: 4,
  falsePositive: 1,
  falseNegative: 1,
  trueNegative: 6,
  abstained: 2,
  precision: 0.8,
  precisionLowerBound: 0.4,
  hitRate: null,
  falsePositiveRate: null,
  ...overrides,
});

const calibration = (model: string, brier: number | null): EvalSetCalibration => ({
  model,
  flaggedLabelled: 10,
  n: brier === null ? 0 : 5,
  brier,
  buckets: [],
});

const report = (overrides: Partial<EvalSetRunReport> = {}): EvalSetRunReport =>
  evalSetRunReportSchema.parse({
    split: 'heldOut',
    examples: 20,
    labelled: 12,
    scores: [],
    recall: {
      flaggedExamples: 5,
      flaggedReviewed: 5,
      flaggedAbuse: 4,
      flaggedPopulation: 5,
      unflaggedExamples: 2,
      unflaggedReviewed: 2,
      unflaggedAbuse: 1,
      unflaggedPopulation: 450,
      minimumReviewed: 30,
      estimatedFlaggedAbuse: 4,
      estimatedMissedAbuse: 225,
      estimatedRecall: 0.5,
      recallWithheld: null,
    },
    cohorts: [],
    labelSources: {},
    ...overrides,
  });

describe('compareEvalSetRuns', () => {
  it('diffs score rows present in both runs', () => {
    const comparison = compareEvalSetRuns(
      report({ scores: [score('m1', { truePositive: 6, abstained: 0, precision: 0.857, precisionLowerBound: 0.5 })] }),
      report({ scores: [score('m1')] })
    );
    expect(comparison.scores).toHaveLength(1);
    expect(comparison.scores[0]).toMatchObject({
      key: 'assessment-m1',
      presence: 'both',
      truePositive: { current: 6, previous: 4, change: 2 },
      falsePositive: { change: 0 },
      abstained: { current: 0, previous: 2, change: -2 },
      precision: { change: 0.057 },
      precisionLowerBound: { change: 0.1 },
    });
  });

  it('marks rows only in one run as added or removed, with no change', () => {
    const comparison = compareEvalSetRuns(
      report({ scores: [score('m1'), score('m2')] }),
      report({ scores: [score('m1'), score('m0')] })
    );
    expect(comparison.scores.map(row => [row.variant, row.presence])).toEqual([
      ['m1', 'both'],
      ['m2', 'added'],
      ['m0', 'removed'],
    ]);
    expect(comparison.scores[1].truePositive).toEqual({ current: 4, previous: null, change: null });
    expect(comparison.scores[2].precision).toEqual({ current: null, previous: 0.8, change: null });
  });

  it('diffs labelled count and estimated recall, with no recall change when either run withheld it', () => {
    const withheld = report({ recall: { ...report().recall, estimatedRecall: null } });
    expect(compareEvalSetRuns(report({ labelled: 15 }), report())).toMatchObject({
      labelled: { current: 15, previous: 12, change: 3 },
      estimatedRecall: { current: 0.5, previous: 0.5, change: 0 },
    });
    expect(compareEvalSetRuns(report(), withheld).estimatedRecall).toEqual({
      current: 0.5,
      previous: null,
      change: null,
    });
  });

  it('diffs Brier per model only when both runs have one', () => {
    const comparison = compareEvalSetRuns(
      report({ calibration: [calibration('m1', 0.12), calibration('m2', 0.2), calibration('m3', null)] }),
      report({ calibration: [calibration('m1', 0.15), calibration('m3', 0.1)] })
    );
    expect(comparison.brier).toEqual([
      { model: 'm1', brier: { current: 0.12, previous: 0.15, change: -0.03 } },
      { model: 'm2', brier: { current: 0.2, previous: null, change: null } },
      { model: 'm3', brier: { current: null, previous: 0.1, change: null } },
    ]);
  });

  it('compares against a run stored before calibration', () => {
    const { calibration: _calibration, ...stored } = report();
    const old = evalSetRunReportSchema.parse(stored);
    expect(compareEvalSetRuns(report({ calibration: [calibration('m1', 0.1)] }), old).brier).toEqual([
      { model: 'm1', brier: { current: 0.1, previous: null, change: null } },
    ]);
  });
});
