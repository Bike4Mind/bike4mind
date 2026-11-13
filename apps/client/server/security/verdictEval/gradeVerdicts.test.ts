import { describe, expect, it } from 'vitest';
import type { CohortSignals } from './cohorts';
import {
  accountLabel,
  gradeVerdicts,
  type EvalDetection,
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
  reviewAutoApproved: false,
  ...overrides,
});

const detection = (overrides: Partial<EvalDetection> & Pick<EvalDetection, 'id' | 'userIds'>): EvalDetection => ({
  detector: 'accountCampaign',
  policyVersion: 1,
  detectedAt: at('5T15:00:00'),
  verdict: null,
  verdicts: [],
  ...overrides,
});

const signals = (overrides: Partial<CohortSignals> = {}): CohortSignals => ({
  userAgent: null,
  deviceTypes: [],
  sharedSignupIp: false,
  apiAgentUsage: false,
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
  spend: new Map(),
  suspendedAt: new Map(),
  cohortSignals: new Map(),
  now: at('6T00:00:00'),
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

  it('does not treat a risk review approved by the auto-approval policy as an admin label', () => {
    expect(accountLabel(outcome('a', { reviewState: 'approved', reviewAutoApproved: true }))).toBeNull();
    expect(
      accountLabel(outcome('a', { reviewState: 'approved', reviewAutoApproved: true, reinstatedAt: at('5T12:00:00') }))
    ).toEqual({ label: 'legit', source: 'reinstated' });
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
          {
            id: 'farm',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['f1', 'f2'],
            detectedAt: at('5T15:00:00'),
            verdict: 'confirmed_abuse',
            verdicts: [],
          },
          {
            id: 'lookalike',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['g1'],
            detectedAt: at('5T15:00:00'),
            verdict: 'legitimate_human',
            verdicts: [],
          },
          {
            id: 'unsure',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['u1'],
            detectedAt: at('5T15:00:00'),
            verdict: 'insufficient_evidence',
            verdicts: [],
          },
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
          {
            id: 'agreed',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['a', 'b'],
            detectedAt: at('5T15:00:00'),
            verdict: null,
            verdicts: [],
          },
          {
            id: 'mixed',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['a', 'c'],
            detectedAt: at('5T15:00:00'),
            verdict: null,
            verdicts: [],
          },
          // Banned by the automation only: no label, so not graded.
          {
            id: 'self',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['d'],
            detectedAt: at('5T15:00:00'),
            verdict: null,
            verdicts: [],
          },
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

  it('labels an automation-graded detection from its members, not as an admin verdict', () => {
    const automation = { source: 'automation' as const };
    const report = gradeVerdicts(
      input({
        detections: [
          {
            id: 'auto',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['a'],
            detectedAt: at('5T15:00:00'),
            verdict: 'insufficient_evidence',
            verdicts: [automation],
          },
        ],
        accounts: [outcome('a', { reviewState: 'approved' })],
        decisions: [
          { detectionId: 'auto', outcome: 'contained', mode: 'enforce', confidence: 0.9, decidedAt: at('5T15:30:00') },
        ],
      })
    );

    expect(report.labelledDetections).toBe(1);
    expect(scoreOf(report, 'containment', 'enforce')).toMatchObject({ truePositive: 0, falsePositive: 1 });
  });

  it('counts an abstention apart from the confusion matrix', () => {
    const report = gradeVerdicts(
      input({
        detections: [
          {
            id: 'farm',
            detector: 'accountCampaign',
            policyVersion: 1,
            userIds: ['f1'],
            detectedAt: at('5T15:00:00'),
            verdict: 'confirmed_abuse',
            verdicts: [],
          },
        ],
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

  it('counts accounts whose only label was an auto-approval and leaves them ungraded', () => {
    const report = gradeVerdicts(
      input({
        accounts: [
          outcome('auto', { reviewState: 'approved', reviewAutoApproved: true }),
          outcome('admin', { reviewState: 'approved' }),
        ],
        signupVerdicts: new Map<string, SignupChartVerdict>([
          ['auto', 'legit'],
          ['admin', 'legit'],
        ]),
      })
    );

    expect(report.excludedAutoApprovals).toBe(1);
    expect(report.labelledAccounts).toBe(1);
  });

  describe('operations', () => {
    const hourBucket = (iso: string, credits: number) => ({ at: at(iso), credits });

    it('reports yield, time to detection and spend around the detection, per detector', () => {
      const report = gradeVerdicts(
        input({
          detections: [
            detection({
              id: 'farm-a',
              userIds: ['f1', 'f2'],
              detectedAt: at('5T15:00:00'),
              verdict: 'confirmed_abuse',
            }),
            detection({
              id: 'farm-b',
              userIds: ['f3'],
              detectedAt: at('5T20:00:00'),
              verdict: 'confirmed_abuse',
            }),
            detection({ id: 'human', userIds: ['h1'], verdict: 'legitimate_human' }),
            detection({ id: 'unsure', userIds: ['u1'], verdict: 'insufficient_evidence' }),
            detection({ id: 'open', userIds: ['o1'], verdict: null }),
            detection({ id: 'device', detector: 'deviceLinkedToBlocked', userIds: ['d1'], verdict: null }),
          ],
          accounts: [outcome('d1', { adminSuspendedAt: at('5T10:00:00'), blockedNow: true })],
          signedUpAt: new Map([
            ['f1', at('5T11:00:00')],
            ['f2', at('5T13:00:00')],
            ['f3', at('5T14:00:00')],
            ['d1', at('5T06:00:00')],
          ]),
          spend: new Map([
            ['f1', [hourBucket('5T12:00:00', 10), hourBucket('5T16:00:00', 7)]],
            ['f2', [hourBucket('5T14:00:00', 5), hourBucket('5T15:00:00', 3)]],
            ['f3', [hourBucket('5T18:00:00', 2), hourBucket('5T21:00:00', 4), hourBucket('5T23:00:00', 9)]],
            // More than SPEND_LOOKBACK_DAYS before its detection: not counted.
            ['d1', [{ at: new Date('2026-10-05T12:00:00Z'), credits: 99 }]],
          ]),
          suspendedAt: new Map([['f3', at('5T22:00:00')]]),
        })
      );

      expect(report.operations.map(row => row.detector)).toEqual(['accountCampaign', 'deviceLinkedToBlocked']);
      const [campaign, device] = report.operations;
      expect(campaign).toMatchObject({ detections: 5, reviewed: 4, conclusive: 3, reviewYield: 0.667 });
      // farm-a: 4h from the earliest member (f1); farm-b: 6h.
      expect(campaign.timeToDetection).toEqual({ n: 2, medianHours: 5, p90Hours: 6 });
      // Before: f1 10, f2 5 (the 15:00 bucket starts at detection, so is after); f3 2.
      // After: f1 7, f2 3, f3 4 (23:00 is past its suspension).
      expect(campaign.spend).toEqual({ accounts: 3, creditsBeforeDetection: 17, creditsAfterDetection: 14 });
      expect(device).toMatchObject({ detections: 1, reviewed: 0, conclusive: 0, reviewYield: null });
      expect(device.timeToDetection).toEqual({ n: 1, medianHours: 9, p90Hours: 9 });
      expect(device.spend).toEqual({ accounts: 1, creditsBeforeDetection: 0, creditsAfterDetection: 0 });
    });

    it('leaves time and spend null when no detection is labelled abuse, and skips negative times', () => {
      const report = gradeVerdicts(
        input({
          detections: [
            detection({ id: 'human', userIds: ['h1'], verdict: 'legitimate_human' }),
            detection({ id: 'odd', userIds: ['x1'], detectedAt: at('5T10:00:00'), verdict: 'confirmed_abuse' }),
          ],
          signedUpAt: new Map([['x1', at('5T12:00:00')]]),
        })
      );

      expect(report.operations).toEqual([
        expect.objectContaining({
          reviewYield: 0.5,
          timeToDetection: null,
          spend: expect.objectContaining({ accounts: 1 }),
        }),
      ]);
    });

    it('counts the hour bucket of a signup that is not hour-aligned', () => {
      // Signed up at 10:30; a 10:45 charge lands in the bucket starting 10:00, before the signup.
      const report = gradeVerdicts(
        input({
          detections: [
            detection({ id: 'farm', userIds: ['f1'], detectedAt: at('5T15:00:00'), verdict: 'confirmed_abuse' }),
          ],
          signedUpAt: new Map([['f1', at('5T10:30:00')]]),
          spend: new Map([['f1', [hourBucket('5T10:00:00', 6)]]]),
        })
      );
      expect(report.operations[0].spend).toEqual({ accounts: 1, creditsBeforeDetection: 6, creditsAfterDetection: 0 });
    });

    it('counts an account in two abuse detections of one detector once, split at the earlier one', () => {
      const report = gradeVerdicts(
        input({
          detections: [
            detection({ id: 'first', userIds: ['f1'], detectedAt: at('5T12:00:00'), verdict: 'confirmed_abuse' }),
            detection({
              id: 'second',
              userIds: ['f1', 'f2'],
              detectedAt: at('5T18:00:00'),
              verdict: 'confirmed_abuse',
            }),
          ],
          spend: new Map([
            ['f1', [hourBucket('5T10:00:00', 1), hourBucket('5T14:00:00', 2), hourBucket('5T19:00:00', 4)]],
            ['f2', [hourBucket('5T14:00:00', 8)]],
          ]),
        })
      );
      // f1 splits at 12:00 (before 1, after 2 + 4); f2 at 18:00 (before 8).
      expect(report.operations[0].spend).toEqual({ accounts: 2, creditsBeforeDetection: 9, creditsAfterDetection: 6 });
    });
  });

  describe('cohorts', () => {
    it('shows how often each cohort of flagged accounts turned out legitimate', () => {
      const report = gradeVerdicts(
        input({
          detections: [
            detection({ id: 'phone', userIds: ['mobile-user'], verdict: 'legitimate_human' }),
            detection({ id: 'office', userIds: ['office-1', 'office-2'], verdict: 'legitimate_human' }),
            detection({ id: 'bot', userIds: ['agent-1'], verdict: 'legitimate_automation' }),
            detection({ id: 'farm', userIds: ['farm-1', 'farm-2'], verdict: 'confirmed_abuse' }),
            detection({ id: 'pending', userIds: ['office-3'], verdict: null }),
          ],
          cohortSignals: new Map([
            ['mobile-user', signals({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' })],
            ['office-1', signals({ sharedSignupIp: true })],
            ['office-2', signals({ sharedSignupIp: true })],
            ['office-3', signals({ sharedSignupIp: true })],
            ['agent-1', signals({ apiAgentUsage: true })],
            ['farm-1', signals({ sharedSignupIp: true, deviceTypes: ['Mobile'] })],
            ['farm-2', signals()],
          ]),
        })
      );

      const row = (cohort: string) => report.cohorts.find(candidate => candidate.cohort === cohort);
      expect(row('mobile')).toEqual({
        cohort: 'mobile',
        measurable: true,
        flaggedAccounts: 2,
        labelledAccounts: 2,
        abuse: 1,
        legit: 1,
        falsePositiveShare: 0.5,
      });
      expect(row('sharedNetwork')).toMatchObject({
        flaggedAccounts: 4,
        labelledAccounts: 3,
        abuse: 1,
        legit: 2,
        falsePositiveShare: 0.667,
      });
      expect(row('apiAgent')).toMatchObject({ flaggedAccounts: 1, legit: 1, falsePositiveShare: 1 });
      expect(row('assistive')).toEqual({
        cohort: 'assistive',
        measurable: false,
        flaggedAccounts: 0,
        labelledAccounts: 0,
        abuse: 0,
        legit: 0,
        falsePositiveShare: null,
      });
    });
  });
});
