import { describe, expect, it, vi } from 'vitest';
import type { AbuseAssessmentResult, ShadowDetectionItem } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  abuseAssessmentRepository: {},
  AdminAuditLogModel: {},
  shadowDetectionRepository: {},
  User: {},
}));

import { autoGradeReason, gradeStaleSignupBursts, type StaleDetectionGradeDeps } from './shadowDetectionAutoGrade';

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const DETECTED_AT = new Date(NOW.getTime() - 10 * DAY_MS);

const detection = (
  id: string,
  userIds: string[],
  overrides: Partial<ShadowDetectionItem> = {}
): ShadowDetectionItem => ({
  id,
  detector: 'signupNetworkBurst',
  policyVersion: 2,
  wouldAction: 'contain',
  summary: '2 self-serve signups from one IP in 180 minutes',
  userIds,
  network: null,
  signals: [],
  windowMinutes: 180,
  group: null,
  payment: null,
  detectedAt: DETECTED_AT,
  verdict: null,
  verdicts: [],
  revision: 0,
  ...overrides,
});

const makeDeps = (
  stale: ShadowDetectionItem[],
  facts: {
    suspended?: string[];
    statusChanges?: [string, Date][];
    flagged?: string[];
    assessments?: [string, AbuseAssessmentResult][];
  } = {}
) => {
  const ordered = [...stale].sort(
    (a, b) => a.detectedAt.getTime() - b.detectedAt.getTime() || a.id.localeCompare(b.id)
  );
  const deps = {
    listStale: vi.fn(async (_before: Date, limit: number, after?: { detectedAt: Date; id: string }) =>
      ordered
        .filter(
          item =>
            !after ||
            item.detectedAt > after.detectedAt ||
            (item.detectedAt.getTime() === after.detectedAt.getTime() && item.id > after.id)
        )
        .slice(0, limit)
    ),
    suspendedUserIds: vi.fn(async () => new Set(facts.suspended ?? [])),
    latestStatusChanges: vi.fn(async () => new Map(facts.statusChanges ?? [])),
    flaggedByOtherDetectors: vi.fn(async () => new Set(facts.flagged ?? [])),
    latestAssessments: vi.fn(async () => new Map(facts.assessments ?? [])),
    grade: vi.fn(async (input: { id: string; verdict: ShadowDetectionItem['verdict']; expectedRevision: number }) => ({
      ...stale.find(item => item.id === input.id)!,
      verdict: input.verdict,
      revision: input.expectedRevision + 1,
    })),
    writeAudit: vi.fn(async () => null),
    logger: { error: vi.fn() },
  };
  return deps satisfies StaleDetectionGradeDeps;
};

const run = (deps: StaleDetectionGradeDeps, afterDays = 7, limits: { limit?: number; scanLimit?: number } = {}) =>
  gradeStaleSignupBursts({ afterDays, now: NOW, deps, ...limits });

describe('gradeStaleSignupBursts', () => {
  it('grades an uncorroborated stale burst insufficient evidence as automation and audits it', async () => {
    const deps = makeDeps([detection('d1', ['u1', 'u2'])]);

    const report = await run(deps);

    expect(deps.listStale).toHaveBeenCalledWith(new Date(NOW.getTime() - 7 * DAY_MS), 500, undefined);
    expect(deps.grade).toHaveBeenCalledWith({
      id: 'd1',
      expectedRevision: 0,
      verdict: 'insufficient_evidence',
      reason: autoGradeReason(7),
    });
    expect(deps.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'security.detection.reviewed',
        target: expect.objectContaining({ kind: 'system', id: 'd1' }),
        details: expect.objectContaining({ verdict: 'insufficient_evidence', source: 'automation' }),
      })
    );
    expect(report).toMatchObject({ considered: 1, graded: 1, failed: 0, scanLimitReached: false });
  });

  it('pages past a full page of skipped detections to grade the one after it', async () => {
    const deps = makeDeps([detection('d1', ['u1']), detection('d2', ['u2']), detection('d3', ['u3'])], {
      flagged: ['u1', 'u2'],
    });

    const report = await run(deps, 7, { limit: 2 });

    expect(deps.grade).toHaveBeenCalledTimes(1);
    expect(deps.grade).toHaveBeenCalledWith(expect.objectContaining({ id: 'd3' }));
    expect(deps.listStale).toHaveBeenNthCalledWith(2, expect.any(Date), 2, { detectedAt: DETECTED_AT, id: 'd2' });
    expect(report).toMatchObject({ considered: 3, graded: 1, skipped: { otherDetector: 2 }, scanLimitReached: false });
  });

  it('stops at the scan limit and reports it', async () => {
    const deps = makeDeps([detection('d1', ['u1']), detection('d2', ['u2']), detection('d3', ['u3'])], {
      flagged: ['u1', 'u2', 'u3'],
    });

    const report = await run(deps, 7, { limit: 2, scanLimit: 3 });

    expect(deps.listStale).toHaveBeenNthCalledWith(2, expect.any(Date), 1, { detectedAt: DETECTED_AT, id: 'd2' });
    expect(report).toMatchObject({ considered: 3, graded: 0, scanLimitReached: true });
  });

  it('grades when the latest assessment is insufficient evidence', async () => {
    const deps = makeDeps([detection('d1', ['u1'])], { assessments: [['d1', 'insufficient_evidence']] });
    expect((await run(deps)).graded).toBe(1);
  });

  it.each([
    ['an account in it is suspended now', { suspended: ['u2'] }, 'accountActioned'],
    [
      'an account in it was suspended or reinstated since the detection',
      { statusChanges: [['u2', new Date(DETECTED_AT.getTime() + DAY_MS)]] as [string, Date][] },
      'accountActioned',
    ],
    ['an account in it was flagged by another detector', { flagged: ['u1'] }, 'otherDetector'],
    [
      'the latest assessment judged abuse',
      { assessments: [['d1', 'abuse']] as [string, AbuseAssessmentResult][] },
      'assessment',
    ],
    [
      'the latest assessment judged legitimate automation',
      { assessments: [['d1', 'legitimate_automation']] as [string, AbuseAssessmentResult][] },
      'assessment',
    ],
  ] as const)('leaves the detection for a person when %s', async (_label, facts, reason) => {
    const deps = makeDeps([detection('d1', ['u1', 'u2'])], facts);

    const report = await run(deps);

    expect(deps.grade).not.toHaveBeenCalled();
    expect(deps.writeAudit).not.toHaveBeenCalled();
    expect(report.skipped[reason]).toBe(1);
  });

  it('ignores a status change that happened before the detection', async () => {
    const deps = makeDeps([detection('d1', ['u1'])], {
      statusChanges: [['u1', new Date(DETECTED_AT.getTime() - DAY_MS)]],
    });
    expect((await run(deps)).graded).toBe(1);
  });

  it('counts a detection someone graded meanwhile without auditing it', async () => {
    const deps = makeDeps([detection('d1', ['u1'])]);
    deps.grade.mockResolvedValue(null as never);

    const report = await run(deps);

    expect(report).toMatchObject({ graded: 0, skipped: expect.objectContaining({ changedMeanwhile: 1 }) });
    expect(deps.writeAudit).not.toHaveBeenCalled();
  });

  it('keeps going when one grade or audit write throws', async () => {
    const deps = makeDeps([detection('d1', ['u1']), detection('d2', ['u2']), detection('d3', ['u3'])]);
    deps.grade.mockRejectedValueOnce(new Error('write failed'));
    deps.writeAudit.mockRejectedValueOnce(new Error('audit failed'));

    const report = await run(deps);

    expect(report).toMatchObject({ considered: 3, graded: 2, failed: 1 });
    expect(deps.writeAudit).toHaveBeenCalledTimes(2);
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, 1.5])('does nothing when the age setting is %s', async afterDays => {
    const deps = makeDeps([detection('d1', ['u1'])]);
    expect((await run(deps, afterDays)).considered).toBe(0);
    expect(deps.listStale).not.toHaveBeenCalled();
  });

  it('reads the account history once for the whole batch, from the oldest detection on', async () => {
    const older = new Date(DETECTED_AT.getTime() - 3 * DAY_MS);
    const deps = makeDeps([detection('d1', ['u1', 'u2'], { detectedAt: older }), detection('d2', ['u2', 'u3'])]);

    await run(deps);

    expect(deps.latestStatusChanges).toHaveBeenCalledTimes(1);
    expect(deps.latestStatusChanges).toHaveBeenCalledWith(['u1', 'u2', 'u3'], older);
    expect(deps.latestAssessments).toHaveBeenCalledWith(['d1', 'd2']);
  });
});
