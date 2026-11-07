import { describe, expect, it } from 'vitest';
import {
  accountLabel,
  gradeVerdicts,
  type EvalAccountOutcome,
  type GradeVerdictsInput,
  type SignupChartVerdict,
} from './gradeVerdicts';

const SINCE = new Date('2026-10-07T00:00:00Z');
const at = (iso: string) => new Date(`2026-11-0${iso}Z`);

const outcome = (userId: string, overrides: Partial<EvalAccountOutcome> = {}): EvalAccountOutcome => ({
  userId,
  adminSuspendedAt: null,
  reinstatedAt: null,
  blockedNow: false,
  reviewState: null,
  ...overrides,
});

const input = (overrides: Partial<GradeVerdictsInput>): GradeVerdictsInput => ({
  since: SINCE,
  detections: [],
  assessments: [],
  decisions: [],
  accounts: [],
  signupVerdicts: new Map(),
  signedUpAt: new Map(),
  truncated: false,
  ...overrides,
});

const scoreOf = (report: ReturnType<typeof gradeVerdicts>, grader: string, variant: string) =>
  report.scores.find(score => score.grader === grader && score.variant === variant);

describe('accountLabel', () => {
  it('labels an admin suspension that still stands as abuse', () => {
    expect(accountLabel(outcome('a', { adminSuspendedAt: at('5T10:00:00'), blockedNow: true }))).toEqual({
      label: 'abuse',
      source: 'adminSuspended',
    });
  });

  it('labels a reinstatement after the suspension as legit', () => {
    expect(accountLabel(outcome('a', { adminSuspendedAt: at('5T10:00:00'), reinstatedAt: at('5T12:00:00') }))).toEqual({
      label: 'legit',
      source: 'reinstated',
    });
  });

  it('labels an account reinstated from an automated containment as legit', () => {
    expect(accountLabel(outcome('a', { reinstatedAt: at('5T12:00:00') }))).toEqual({
      label: 'legit',
      source: 'reinstated',
    });
  });

  it('falls back to the closed risk review', () => {
    expect(accountLabel(outcome('a', { reviewState: 'banned' }))).toEqual({ label: 'abuse', source: 'riskReview' });
    expect(accountLabel(outcome('a', { reviewState: 'approved' }))).toEqual({ label: 'legit', source: 'riskReview' });
  });

  it('leaves an account banned only by the automation, or under review, unlabelled', () => {
    expect(accountLabel(outcome('a', { blockedNow: true }))).toBeNull();
    expect(accountLabel(outcome('a', { reviewState: 'pending' }))).toBeNull();
  });
});

describe('gradeVerdicts', () => {
  it('counts the farm the signup chart called Likely legit as a missed hit', () => {
    const farm = ['farm-1', 'farm-2'];
    const verdicts = new Map<string, SignupChartVerdict>([
      ['farm-1', 'legit'],
      ['farm-2', 'legit'],
      ['genuine', 'legit'],
      ['burst', 'suspected'],
    ]);
    const report = gradeVerdicts(
      input({
        accounts: [
          ...farm.map(id => outcome(id, { adminSuspendedAt: at('6T09:00:00'), blockedNow: true })),
          outcome('genuine', { reviewState: 'approved' }),
          outcome('burst', { adminSuspendedAt: at('6T09:00:00'), blockedNow: true }),
        ],
        signupVerdicts: verdicts,
        signedUpAt: new Map([
          ['farm-1', at('5T14:43:00')],
          ['farm-2', at('5T16:10:00')],
        ]),
      })
    );

    expect(scoreOf(report, 'signupVerdict', 'chart')).toEqual({
      grader: 'signupVerdict',
      variant: 'chart',
      truePositive: 1,
      falsePositive: 0,
      falseNegative: 2,
      trueNegative: 1,
      abstained: 0,
      precision: 1,
      hitRate: 0.333,
      falsePositiveRate: 0,
    });
    expect(report.disagreements.map(row => [row.userId, row.kind, row.predicted, row.labelSource])).toEqual([
      ['farm-2', 'falseNegative', 'legit', 'adminSuspended'],
      ['farm-1', 'falseNegative', 'legit', 'adminSuspended'],
    ]);
  });

  it('grades each model and mode on the latest verdict against the admin verdict', () => {
    const report = gradeVerdicts(
      input({
        detections: [
          { id: 'farm', userIds: ['f1', 'f2'], detectedAt: at('5T15:00:00'), verdict: 'confirmed_abuse' },
          { id: 'lookalike', userIds: ['g1'], detectedAt: at('5T15:00:00'), verdict: 'legitimate_human' },
          { id: 'unsure', userIds: ['u1'], detectedAt: at('5T15:00:00'), verdict: 'insufficient_evidence' },
        ],
        assessments: [
          // Superseded by the newer assessment of the same detection and model.
          { detectionId: 'farm', result: 'abuse', confidence: 0.9, model: 'jev', assessedAt: at('5T15:01:00') },
          {
            detectionId: 'farm',
            result: 'legitimate_automation',
            confidence: 0.7,
            model: 'jev',
            assessedAt: at('5T15:05:00'),
          },
          { detectionId: 'farm', result: 'abuse', confidence: 0.95, model: 'luna', assessedAt: at('5T15:05:00') },
          { detectionId: 'lookalike', result: 'abuse', confidence: 0.8, model: 'luna', assessedAt: at('5T15:06:00') },
          { detectionId: 'unsure', result: 'abuse', confidence: 0.8, model: 'luna', assessedAt: at('5T15:06:00') },
        ],
        decisions: [
          {
            detectionId: 'farm',
            outcome: 'would_contain',
            mode: 'shadow',
            confidence: 0.95,
            decidedAt: at('5T15:06:00'),
          },
          {
            detectionId: 'lookalike',
            outcome: 'would_contain',
            mode: 'shadow',
            confidence: 0.8,
            decidedAt: at('5T15:07:00'),
          },
        ],
      })
    );

    expect(report).toMatchObject({ detections: 3, labelledDetections: 2 });
    expect(scoreOf(report, 'assessment', 'jev')).toMatchObject({ falseNegative: 1, truePositive: 0, hitRate: 0 });
    expect(scoreOf(report, 'assessment', 'luna')).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      precision: 0.5,
      falsePositiveRate: 1,
    });
    expect(scoreOf(report, 'containment', 'shadow')).toMatchObject({
      truePositive: 1,
      falsePositive: 1,
      precision: 0.5,
    });
    expect(report.disagreements.map(row => [row.grader, row.variant, row.detectionId, row.kind])).toEqual([
      ['containment', 'shadow', 'lookalike', 'falsePositive'],
      ['assessment', 'luna', 'lookalike', 'falsePositive'],
      ['assessment', 'jev', 'farm', 'falseNegative'],
    ]);
  });

  it('labels an unreviewed detection from its members only when they agree', () => {
    const report = gradeVerdicts(
      input({
        detections: [
          { id: 'agreed', userIds: ['a', 'b'], detectedAt: at('5T15:00:00'), verdict: null },
          { id: 'mixed', userIds: ['a', 'c'], detectedAt: at('5T15:00:00'), verdict: null },
          // Banned by the automation only: no label, so not graded.
          { id: 'self', userIds: ['d'], detectedAt: at('5T15:00:00'), verdict: null },
        ],
        accounts: [
          outcome('a', { adminSuspendedAt: at('5T16:00:00'), blockedNow: true }),
          outcome('b'),
          outcome('c', { reinstatedAt: at('5T17:00:00') }),
          outcome('d', { blockedNow: true }),
        ],
        decisions: ['agreed', 'mixed', 'self'].map(detectionId => ({
          detectionId,
          outcome: 'contained' as const,
          mode: 'enforce',
          confidence: 0.9,
          decidedAt: at('5T15:30:00'),
        })),
      })
    );

    expect(report.labelledDetections).toBe(1);
    expect(scoreOf(report, 'containment', 'enforce')).toMatchObject({ truePositive: 1, falsePositive: 0 });
  });

  it('counts an abstention apart from the confusion matrix', () => {
    const report = gradeVerdicts(
      input({
        detections: [{ id: 'farm', userIds: ['f1'], detectedAt: at('5T15:00:00'), verdict: 'confirmed_abuse' }],
        assessments: [
          {
            detectionId: 'farm',
            result: 'insufficient_evidence',
            confidence: 0.4,
            model: 'jev',
            assessedAt: at('5T15:05:00'),
          },
        ],
      })
    );

    expect(scoreOf(report, 'assessment', 'jev')).toMatchObject({
      abstained: 1,
      truePositive: 0,
      falseNegative: 0,
      precision: null,
      hitRate: null,
    });
    expect(report.disagreements).toEqual([]);
  });
});
