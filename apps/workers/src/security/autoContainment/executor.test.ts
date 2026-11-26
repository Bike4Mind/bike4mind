import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoContainmentConfigSchema,
  INTERVENTION_POLICY_VERSION,
  RISK_EVIDENCE_VERSION,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentDecisionItem,
  type InterventionHold,
  type LinkRuleFacts,
  type ShadowDetectionItem,
} from '@bike4mind/common';

const h = vi.hoisted(() => ({
  resolve: vi.fn(),
  execute: vi.fn(),
  depsFor: vi.fn(() => ({ marker: 'execute-deps' })),
  writer: vi.fn(() => 'system-writer'),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  autoContainmentDecisionRepository: {},
  cacheRepository: {},
  shadowDetectionRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/server-utils/admin/usersBulk/adapters', () => ({
  usersBulkExecuteDepsFor: h.depsFor,
  usersBulkResolveDeps: {},
}));
vi.mock('@bike4mind/server-utils/admin/usersBulk/execute', () => ({ executeAdminUsersBulk: h.execute }));
vi.mock('@bike4mind/server-utils/admin/usersBulk/resolve', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/admin/usersBulk/resolve')>()),
  resolveAdminUsersBulk: h.resolve,
}));
vi.mock('@workers/utils/systemAuditWriter', () => ({ systemAuditWriter: h.writer }));
vi.mock('@bike4mind/server-utils/security/autoContainment/linkRuleFacts', () => ({ loadLinkRuleFacts: vi.fn() }));

import type { AdminUsersBulkResult } from '@bike4mind/server-utils/app/utils/adminUsersBulk';
import { cohortHashOf } from '@bike4mind/server-utils/admin/usersBulk/resolve';
import {
  AUTO_CONTAINMENT_ACTOR,
  AUTO_CONTAINMENT_ACTOR_ID,
  STALE_PENDING_MS,
  applyAutoContainment,
  containAsSystem,
  type AutoContainmentDeps,
} from './executor';

const NOW = new Date('2026-11-05T10:00:00Z');

const assessment: AbuseAssessmentItem = {
  id: 'assessment-1',
  detectionId: 'detection-1',
  result: 'abuse',
  probabilities: [],
  confidence: 0.97,
  reasons: [],
  model: 'jev-1.13.0',
  modelVersion: null,
  policyVersion: 1,
  evidenceVersion: RISK_EVIDENCE_VERSION,
  evidenceHash: 'hash',
  featureSummary: {
    evidenceVersion: RISK_EVIDENCE_VERSION,
    detection: {
      detector: 'youngAccountSpend',
      detectorPolicyVersion: 1,
      windowMinutes: 60,
      hostingNetwork: null,
      signals: [],
    },
    accounts: [],
    accountsOmitted: 0,
    group: null,
  },
  failure: null,
  attempts: 1,
  costUsd: 0,
  trigger: 'sweep',
  requestedBy: null,
  assessedAt: NOW,
};

const detection: ShadowDetectionItem = {
  id: 'detection-1',
  detector: 'youngAccountSpend',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: 'big spend',
  userIds: ['user-1'],
  network: null,
  signals: [],
  windowMinutes: 60,
  group: null,
  payment: null,
  detectedAt: NOW,
  verdict: null,
  verdicts: [],
  revision: 0,
};

const bulkResult = {
  batchId: 'batch-1',
  applied: 1,
  committedUserIds: ['user-1'],
  skipped: 0,
  failed: [],
  partial: false,
  remaining: 0,
  undoExpiresAt: NOW.toISOString(),
  blockedDomains: [],
  canceledSubscriptions: 0,
  subscriptionCancelFailures: [],
};

type Row = AutoContainmentDecisionItem;

/** An in-memory decisions store with the repository's claim semantics (unique claim class, atomic reclaim). */
function makeDecisions() {
  const stored: Row[] = [];
  return {
    stored,
    listForDetection: vi.fn(async (detectionId: string) => stored.filter(row => row.detectionId === detectionId)),
    recordOnce: vi.fn(async (input: Omit<Row, 'id'>) => {
      if (
        stored.some(
          row =>
            row.detectionId === input.detectionId &&
            row.revision === input.revision &&
            (row.tier === 'contain') === ((input.tier ?? 'contain') === 'contain')
        )
      )
        return null;
      const row = { tier: 'contain' as const, ...input, id: `decision-${stored.length + 1}` };
      stored.push(row);
      return { ...row };
    }),
    reclaim: vi.fn(
      async (
        id: string,
        options: { staleBefore: Date; cappedBefore: Date; now: Date; mode: Row['mode'] }
      ): Promise<Row | null> => {
        const row = stored.find(candidate => candidate.id === id);
        if (!row) return null;
        const stale = row.outcome === 'pending' && row.decidedAt < options.staleBefore;
        const reset = row.outcome === 'capped' && row.decidedAt < options.cappedBefore;
        if (!stale && !reset) return null;
        Object.assign(row, { outcome: 'pending', mode: options.mode, decidedAt: options.now });
        return { ...row };
      }
    ),
    release: vi.fn(async (id: string, _input: { reason: string; condition: string }) => {
      const row = stored.find(candidate => candidate.id === id);
      if (row) Object.assign(row, { outcome: 'released' });
      return row ? { ...row } : null;
    }),
    finish: vi.fn(async (id: string, patch: Pick<Row, 'outcome' | 'batchId' | 'error'>, decidedAt: Date) => {
      const row = stored.find(
        candidate =>
          candidate.id === id &&
          candidate.outcome === 'pending' &&
          candidate.decidedAt.getTime() === decidedAt.getTime()
      );
      if (!row) return false;
      Object.assign(row, patch);
      return true;
    }),
  };
}

function makeDeps(config: Partial<AutoContainmentConfig> = {}, slot = true, decisions = makeDecisions()) {
  let now = NOW;
  const deps = {
    loadConfig: vi.fn(async () => AutoContainmentConfigSchema.parse(config)),
    findDetection: vi.fn(async (): Promise<ShadowDetectionItem | null> => detection),
    decisions,
    takeHourlySlot: vi.fn(async (_mode: Row['mode'], _maxPerHour: number, _tier?: string) => slot),
    contain: vi.fn(async (): Promise<AdminUsersBulkResult | null> => bulkResult),
    applyHold: vi.fn(async (_userId: string, _hold: InterventionHold) => true),
    releaseHold: vi.fn(async (_userId: string, _decisionId: string) => true),
    releaseContainedHolds: vi.fn(async (decisionId: string, userIds: string[]) => {
      const row = decisions.stored.find(candidate => candidate.id === decisionId);
      if (row && row.userIds.every(userId => userIds.includes(userId))) {
        Object.assign(row, { outcome: 'released', releasedAt: now, releaseCondition: 'contained' });
      }
    }),
    auditHold: vi.fn(async (_userId: string, _decision: Row) => undefined),
    verificationAvailable: vi.fn(async () => false),
    loadLinkRuleFacts: vi.fn(
      async (_userIds: string[], _config: AutoContainmentConfig): Promise<LinkRuleFacts[]> => []
    ),
    now: () => now,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies AutoContainmentDeps;
  return { deps, stored: decisions.stored, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('applyAutoContainment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a would_contain decision in shadow mode (the default) and touches no account', async () => {
    const { deps, stored } = makeDeps();
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { mode: 'shadow', outcome: 'would_contain', userIds: ['user-1'], revision: 0 },
    });
    expect(stored[0].outcome).toBe('would_contain');
    expect(deps.takeHourlySlot).toHaveBeenCalledWith('shadow', 5);
    expect(deps.contain).not.toHaveBeenCalled();
  });

  it('contains through the bulk path in enforce mode, with the evidence as the reason', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce', blockEmailDomains: true });
    const run = await applyAutoContainment(assessment, deps);
    expect(deps.decisions.recordOnce).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending' }));
    expect(deps.takeHourlySlot).toHaveBeenCalledWith('enforce', 5);
    expect(deps.contain).toHaveBeenCalledWith({
      userIds: ['user-1'],
      reason: expect.stringContaining('abuse assessment assessment-1'),
      idempotencyKey: 'auto-containment:detection-1:0',
      blockEmailDomains: true,
    });
    expect(stored[0]).toMatchObject({ outcome: 'contained', batchId: 'batch-1', error: null });
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'contained', batchId: 'batch-1' } });
  });

  it('records failed when the bulk path fails for an account or throws', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce' });
    deps.contain.mockResolvedValueOnce({
      ...bulkResult,
      applied: 0,
      failed: [{ userId: 'user-1', error: 'write conflict' }],
    });
    await applyAutoContainment(assessment, deps);
    expect(stored[0]).toMatchObject({
      outcome: 'failed',
      batchId: 'batch-1',
      error: '1 account(s) failed: write conflict',
    });

    const second = makeDeps({ mode: 'enforce' });
    second.deps.contain.mockRejectedValueOnce(new Error('db down'));
    await applyAutoContainment(assessment, second.deps);
    expect(second.stored[0]).toMatchObject({ outcome: 'failed', batchId: null, error: 'db down' });
    expect(second.deps.logger.error).toHaveBeenCalled();
  });

  it('records failed, not contained, when no account was eligible', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce' });
    deps.contain.mockResolvedValueOnce(null);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ decision: { outcome: 'failed', error: expect.stringContaining('no eligible') } });
    expect(stored[0].outcome).toBe('failed');
  });

  it('leaves a time-budget partial pending and retries it with the same key once stale', async () => {
    const { deps, stored, advance } = makeDeps({ mode: 'enforce' });
    deps.contain.mockResolvedValueOnce({ ...bulkResult, partial: true, remaining: 2 });
    await applyAutoContainment(assessment, deps);
    expect(stored[0].outcome).toBe('pending');

    expect(await applyAutoContainment(assessment, deps)).toEqual({ status: 'skipped', reason: 'already_decided' });

    advance(STALE_PENDING_MS + 1);
    const retry = await applyAutoContainment(assessment, deps);
    expect(retry).toMatchObject({ status: 'decided', decision: { outcome: 'contained' } });
    expect(deps.contain).toHaveBeenCalledTimes(2);
    expect(deps.contain).toHaveBeenLastCalledWith(
      expect.objectContaining({ idempotencyKey: 'auto-containment:detection-1:0' })
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[AUTO_CONTAINMENT] retrying a decision a run left pending',
      expect.objectContaining({ detectionId: 'detection-1' })
    );
  });

  it('retries a claim a run died holding once it is stale', async () => {
    const decisions = makeDecisions();
    const { deps, advance } = makeDeps({ mode: 'enforce' }, true, decisions);
    await decisions.recordOnce({
      detectionId: 'detection-1',
      revision: 0,
      assessmentId: 'assessment-0',
      mode: 'enforce',
      outcome: 'pending',
      userIds: ['user-1'],
      confidence: 0.97,
      reason: 'earlier run',
      batchId: null,
      error: null,
      decidedAt: NOW,
    });
    advance(STALE_PENDING_MS + 1);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'contained', reason: 'earlier run' } });
  });

  it('records capped once the hourly window is spent, and re-evaluates it after the window', async () => {
    const { deps, stored, advance } = makeDeps({ mode: 'enforce' }, false);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'capped' } });
    expect(deps.contain).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();

    expect(await applyAutoContainment(assessment, deps)).toEqual({ status: 'skipped', reason: 'already_decided' });

    advance(60 * 60 * 1000 + 1);
    deps.takeHourlySlot.mockResolvedValue(true);
    await applyAutoContainment(assessment, deps);
    expect(stored[0].outcome).toBe('contained');
  });

  it('decides each revision once, and a losing claim spends no slot', async () => {
    const { deps } = makeDeps({ mode: 'enforce' });
    await applyAutoContainment(assessment, deps);
    const again = await applyAutoContainment({ ...assessment, id: 'assessment-2' }, deps);
    expect(again).toEqual({ status: 'skipped', reason: 'already_decided' });

    deps.decisions.recordOnce.mockResolvedValueOnce(null);
    deps.findDetection.mockResolvedValueOnce({ ...detection, id: 'detection-2' });
    const lost = await applyAutoContainment({ ...assessment, detectionId: 'detection-2' }, deps);
    expect(lost).toEqual({ status: 'skipped', reason: 'already_decided' });
    expect(deps.takeHourlySlot).toHaveBeenCalledTimes(1);
    expect(deps.contain).toHaveBeenCalledTimes(1);
  });

  it('decides a later revision of a growing campaign for its new members only', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce' });
    await applyAutoContainment(assessment, deps);

    deps.findDetection.mockResolvedValue({ ...detection, userIds: ['user-1', 'user-2'], revision: 1 });
    const grown = await applyAutoContainment(assessment, deps);
    expect(grown).toMatchObject({ decision: { revision: 1, userIds: ['user-2'], outcome: 'contained' } });
    expect(deps.contain).toHaveBeenLastCalledWith(
      expect.objectContaining({ userIds: ['user-2'], idempotencyKey: 'auto-containment:detection-1:1' })
    );

    deps.findDetection.mockResolvedValue({ ...detection, userIds: ['user-2', 'user-1'], revision: 2 });
    expect(await applyAutoContainment(assessment, deps)).toEqual({ status: 'skipped', reason: 'already_decided' });
    expect(stored).toHaveLength(2);
  });

  it('withdraws the decision when an admin rules before the Contain runs', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce' });
    deps.findDetection
      .mockResolvedValueOnce(detection)
      .mockResolvedValueOnce({ ...detection, verdict: 'legitimate_human' });
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ decision: { outcome: 'withdrawn' } });
    expect(stored[0].outcome).toBe('withdrawn');
    expect(deps.contain).not.toHaveBeenCalled();
  });

  it('does nothing when off, for a weak judgment, or for a reviewed or missing detection', async () => {
    const off = makeDeps({ mode: 'off' });
    expect(await applyAutoContainment(assessment, off.deps)).toEqual({ status: 'skipped', reason: 'mode_off' });
    expect(off.deps.findDetection).not.toHaveBeenCalled();

    const weak = makeDeps({ mode: 'enforce' });
    expect(await applyAutoContainment({ ...assessment, confidence: 0.6 }, weak.deps)).toEqual({
      status: 'skipped',
      reason: 'below_confidence',
    });

    const reviewed = makeDeps({ mode: 'enforce' });
    reviewed.deps.findDetection.mockResolvedValueOnce({ ...detection, verdict: 'legitimate_human' });
    expect(await applyAutoContainment(assessment, reviewed.deps)).toEqual({
      status: 'skipped',
      reason: 'already_reviewed',
    });

    const missing = makeDeps({ mode: 'enforce' });
    missing.deps.findDetection.mockResolvedValueOnce(null);
    expect(await applyAutoContainment(assessment, missing.deps)).toEqual({
      status: 'skipped',
      reason: 'detection_not_found',
    });
    for (const { deps } of [weak, reviewed, missing]) expect(deps.contain).not.toHaveBeenCalled();
  });
});

describe('containAsSystem', () => {
  beforeEach(() => vi.clearAllMocks());

  const request = {
    userIds: ['user-1', 'admin-1'],
    reason: 'evidence',
    idempotencyKey: 'key-1',
    blockEmailDomains: false,
  };

  it('runs the bulk Contain as the system actor on the eligible cohort', async () => {
    const eligible = [{ id: 'user-1', email: 'a@example.test', name: 'A', isAdmin: false }];
    h.resolve.mockResolvedValue({ eligible });
    h.execute.mockResolvedValue(bulkResult);

    expect(await containAsSystem()(request)).toBe(bulkResult);
    expect(h.resolve).toHaveBeenCalledWith({ kind: 'ids', userIds: request.userIds }, [], {}, expect.any(Date), {
      actorIsFullAdmin: true,
    });
    expect(h.writer).toHaveBeenCalledWith(AUTO_CONTAINMENT_ACTOR, 'security/autoContainment', undefined);
    expect(h.depsFor).toHaveBeenCalledWith('system-writer', 'evidence', undefined);
    expect(h.execute).toHaveBeenCalledWith(
      {
        target: { kind: 'ids', userIds: request.userIds },
        action: { type: 'contain', blockEmailDomains: false },
        reason: 'evidence',
        idempotencyKey: 'key-1',
        expectedCount: 1,
        cohortHash: cohortHashOf(eligible as never),
      },
      { id: AUTO_CONTAINMENT_ACTOR_ID, selfIds: [], fullAdmin: true },
      { marker: 'execute-deps' }
    );
  });

  it('returns null and runs nothing when no account is eligible', async () => {
    h.resolve.mockResolvedValue({ eligible: [] });
    expect(await containAsSystem()(request)).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe('applyAutoContainment graduated tiers', () => {
  beforeEach(() => vi.clearAllMocks());

  const holdGrantDetection: ShadowDetectionItem = {
    ...detection,
    wouldAction: 'confirmHold',
    userIds: ['user-1', 'user-2'],
  };
  const tierConfig = (mode: 'off' | 'shadow' | 'enforce', extra: Record<string, unknown> = {}) =>
    ({
      mode: 'enforce',
      tiers: { holdGrant: { mode, rolloutPercent: 100, ...extra } },
    }) as Partial<AutoContainmentConfig>;
  const withDetection = (deps: AutoContainmentDeps, found: ShadowDetectionItem) =>
    vi.mocked(deps.findDetection).mockResolvedValue(found);

  it('does nothing while the tier is off (the default), even with Contain enforcing', async () => {
    const { deps, stored } = makeDeps({ mode: 'enforce' });
    withDetection(deps, holdGrantDetection);
    expect(await applyAutoContainment(assessment, deps)).toEqual({ status: 'skipped', reason: 'tier_off' });
    expect(stored).toHaveLength(0);
    expect(deps.applyHold).not.toHaveBeenCalled();
  });

  it('turns every tier off through the global kill switch', async () => {
    const { deps } = makeDeps({ ...tierConfig('enforce'), mode: 'off' });
    withDetection(deps, holdGrantDetection);
    expect(await applyAutoContainment(assessment, deps)).toEqual({ status: 'skipped', reason: 'mode_off' });
    expect(deps.findDetection).not.toHaveBeenCalled();
  });

  it('records would_intervene in shadow and writes no hold', async () => {
    const { deps, stored } = makeDeps(tierConfig('shadow'));
    withDetection(deps, holdGrantDetection);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { tier: 'holdGrant', mode: 'shadow', outcome: 'would_intervene' },
    });
    expect(stored[0]).toMatchObject({
      tier: 'holdGrant',
      policyVersion: INTERVENTION_POLICY_VERSION,
      scope: 'signup_grant',
    });
    expect(stored[0].expiresAt).toEqual(new Date(NOW.getTime() + 72 * 3_600_000));
    expect(deps.takeHourlySlot).toHaveBeenCalledWith('shadow', 5, 'holdGrant');
    expect(deps.applyHold).not.toHaveBeenCalled();
    expect(deps.contain).not.toHaveBeenCalled();
  });

  it('adds one hold per account in enforce and audits each, never through the Contain path', async () => {
    const { deps, stored } = makeDeps(tierConfig('enforce', { maxPerHour: 3 }));
    withDetection(deps, holdGrantDetection);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'intervened' } });
    expect(deps.takeHourlySlot).toHaveBeenCalledWith('enforce', 3, 'holdGrant');
    expect(deps.applyHold).toHaveBeenCalledTimes(2);
    expect(deps.applyHold).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({
        decisionId: stored[0].id,
        tier: 'holdGrant',
        releasedAt: null,
        expiresAt: stored[0].expiresAt,
      }),
      stored[0].decidedAt
    );
    expect(deps.auditHold).toHaveBeenCalledTimes(2);
    expect(deps.contain).not.toHaveBeenCalled();
  });

  it('snapshots the credits-per-hour limit onto a limit hold', async () => {
    const { deps } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', rolloutPercent: 100, creditsPerHour: 40 } },
    } as never);
    withDetection(deps, { ...detection, wouldAction: 'limit' });
    await applyAutoContainment(assessment, deps);
    expect(deps.applyHold).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ tier: 'limit', creditsPerHour: 40 }),
      expect.any(Date)
    );
  });

  it('records verify as review when no verification flow is available', async () => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: { review: { mode: 'shadow', rolloutPercent: 100 } },
    } as never);
    withDetection(deps, { ...detection, wouldAction: 'verify' });
    await applyAutoContainment(assessment, deps);
    expect(stored[0].tier).toBe('review');
  });

  it('caps by the tier hourly window', async () => {
    const { deps, stored } = makeDeps(tierConfig('enforce'), false);
    withDetection(deps, holdGrantDetection);
    await applyAutoContainment(assessment, deps);
    expect(stored[0].outcome).toBe('capped');
    expect(deps.applyHold).not.toHaveBeenCalled();
  });

  it('withdraws when an admin verdict lands before the hold', async () => {
    const { deps, stored } = makeDeps(tierConfig('enforce'));
    vi.mocked(deps.findDetection)
      .mockResolvedValueOnce(holdGrantDetection)
      .mockResolvedValueOnce({ ...holdGrantDetection, verdict: 'legitimate' } as ShadowDetectionItem);
    await applyAutoContainment(assessment, deps);
    expect(stored[0].outcome).toBe('withdrawn');
    expect(deps.applyHold).not.toHaveBeenCalled();
  });

  it('lets exactly one of two concurrent runs act', async () => {
    const { deps } = makeDeps(tierConfig('enforce'));
    withDetection(deps, holdGrantDetection);
    const runs = await Promise.all([applyAutoContainment(assessment, deps), applyAutoContainment(assessment, deps)]);
    expect(runs.filter(run => run.status === 'decided')).toHaveLength(1);
    expect(runs).toContainEqual({ status: 'skipped', reason: 'already_decided' });
    expect(deps.applyHold).toHaveBeenCalledTimes(2);
  });

  it('retries a stale pending decision with the same decision id, so the hold is not stacked', async () => {
    const { deps, stored, advance } = makeDeps(tierConfig('enforce'));
    withDetection(deps, holdGrantDetection);
    vi.mocked(deps.applyHold).mockRejectedValueOnce(new Error('write timeout'));
    await applyAutoContainment(assessment, deps);
    expect(stored[0].outcome).toBe('failed');
    stored[0].outcome = 'pending';
    advance(STALE_PENDING_MS + 1);
    await applyAutoContainment({ ...assessment, assessedAt: new Date(NOW.getTime() + STALE_PENDING_MS) }, deps);
    expect(stored[0].outcome).toBe('intervened');
    const decisionIds = vi.mocked(deps.applyHold).mock.calls.map(([, hold]) => hold.decisionId);
    expect(new Set(decisionIds)).toEqual(new Set([stored[0].id]));
  });

  it('marks the decision failed when a hold write throws, and still holds the other accounts', async () => {
    const { deps, stored } = makeDeps(tierConfig('enforce'));
    withDetection(deps, holdGrantDetection);
    vi.mocked(deps.applyHold).mockRejectedValueOnce(new Error('boom'));
    await applyAutoContainment(assessment, deps);
    expect(stored[0]).toMatchObject({ outcome: 'failed', error: expect.stringContaining('user-1: boom') });
    expect(deps.applyHold).toHaveBeenCalledTimes(2);
  });
});

describe('applyAutoContainment Contain fallback to the limit tier', () => {
  beforeEach(() => vi.clearAllMocks());
  const config = {
    mode: 'enforce',
    tiers: { limit: { mode: 'shadow', minConfidence: 0.7, rolloutPercent: 100 } },
  } as Partial<AutoContainmentConfig>;

  it('keeps concurrent different graduated tiers in one claim slot', async () => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: {
        limit: { mode: 'enforce', rolloutPercent: 100 },
        review: { mode: 'enforce', rolloutPercent: 100 },
      },
    } as Partial<AutoContainmentConfig>);
    deps.findDetection
      .mockResolvedValueOnce({ ...detection, wouldAction: 'limit' })
      .mockResolvedValueOnce({ ...detection, wouldAction: 'verify' });
    const runs = await Promise.all([
      applyAutoContainment(assessment, deps),
      applyAutoContainment({ ...assessment, id: 'assessment-2' }, deps),
    ]);
    expect(stored).toHaveLength(1);
    expect(runs.filter(run => run.status === 'decided')).toHaveLength(1);
    expect(deps.applyHold).toHaveBeenCalledTimes(1);
  });

  it('records would_intervene on the limit tier for a contain detection judged below Contain minConfidence', async () => {
    const { deps, stored } = makeDeps(config);
    const run = await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { tier: 'limit', mode: 'shadow', outcome: 'would_intervene' },
    });
    expect(stored).toHaveLength(1);
    expect(deps.contain).not.toHaveBeenCalled();
    expect(deps.applyHold).not.toHaveBeenCalled();
  });

  it('still contains an account a later revision judges at Contain confidence', async () => {
    const { deps } = makeDeps(config);
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    vi.mocked(deps.findDetection).mockResolvedValue({ ...detection, revision: 1 });
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { tier: 'contain', outcome: 'contained', userIds: ['user-1'] },
    });
    expect(deps.contain).toHaveBeenCalledTimes(1);
  });

  it('contains on the same revision once a later judgment reaches Contain confidence, lifting the limit hold', async () => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
    } as Partial<AutoContainmentConfig>);
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    expect(stored[0]).toMatchObject({ tier: 'limit', outcome: 'intervened' });
    expect(deps.applyHold).toHaveBeenCalledTimes(1);

    const run = await applyAutoContainment({ ...assessment, id: 'assessment-2' }, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { id: stored[1].id, tier: 'contain', outcome: 'contained', userIds: ['user-1'] },
    });
    expect(deps.contain).toHaveBeenCalledTimes(1);
    expect(deps.releaseContainedHolds).toHaveBeenCalledWith(stored[0].id, ['user-1']);
    expect(stored[0]).toMatchObject({ tier: 'limit', outcome: 'released', releaseCondition: 'contained' });
    expect(stored[0].expiresAt).not.toBeNull();
    expect(stored).toHaveLength(2);
  });

  it.each(['shadow', 'capped', 'withdrawn', 'no_accounts', 'throws', 'all_failed'] as const)(
    'preserves the original graduated hold and release history when Contain is %s',
    async scenario => {
      const { deps, stored } = makeDeps({
        mode: 'enforce',
        tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
      } as Partial<AutoContainmentConfig>);
      await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
      const original = structuredClone(stored[0]);
      if (scenario === 'shadow')
        deps.loadConfig.mockResolvedValue(AutoContainmentConfigSchema.parse({ mode: 'shadow' }));
      if (scenario === 'capped') deps.takeHourlySlot.mockResolvedValue(false);
      if (scenario === 'withdrawn') {
        deps.findDetection
          .mockResolvedValueOnce(detection)
          .mockResolvedValueOnce({ ...detection, verdict: 'legitimate_human' });
      }
      if (scenario === 'no_accounts') deps.contain.mockResolvedValue(null);
      if (scenario === 'throws') deps.contain.mockRejectedValue(new Error('contain unavailable'));
      if (scenario === 'all_failed')
        deps.contain.mockResolvedValue({
          ...bulkResult,
          applied: 0,
          committedUserIds: [],
          failed: [{ userId: 'user-1', error: 'rolled back' }],
        });

      await applyAutoContainment({ ...assessment, id: 'assessment-2' }, deps);

      expect(stored[0]).toEqual(original);
      expect(deps.releaseHold).not.toHaveBeenCalled();
      expect(deps.releaseContainedHolds).not.toHaveBeenCalled();
      expect(stored).toHaveLength(2);
    }
  );

  it.each([false, true])('lifts only committed accounts from partial Contain (failed=%s)', async failed => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
    } as Partial<AutoContainmentConfig>);
    deps.findDetection.mockResolvedValue({ ...detection, userIds: ['user-1', 'user-2'] });
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    const original = structuredClone(stored[0]);
    deps.contain.mockResolvedValue({
      ...bulkResult,
      committedUserIds: ['user-1', 'outside-cohort'],
      partial: !failed,
      remaining: failed ? 0 : 1,
      failed: failed ? [{ userId: 'user-2', error: 'rolled back' }] : [],
    });
    await applyAutoContainment(assessment, deps);
    expect(deps.releaseContainedHolds).toHaveBeenCalledExactlyOnceWith(original.id, ['user-1']);
    expect(stored[0]).toEqual(original);
  });

  it('retries a pending graduated account left outside a partial Contain receipt', async () => {
    const { deps, stored, advance } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
    } as Partial<AutoContainmentConfig>);
    deps.findDetection.mockResolvedValue({ ...detection, userIds: ['user-1', 'user-2'] });
    deps.applyHold.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('worker interrupted'));
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    stored[0].outcome = 'pending';
    const graduatedId = stored[0].id;
    deps.contain.mockResolvedValue({ ...bulkResult, committedUserIds: ['user-1'], partial: true, remaining: 1 });
    await applyAutoContainment(assessment, deps);
    deps.applyHold.mockClear();
    advance(STALE_PENDING_MS + 1);
    const retried = await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    expect(retried).toMatchObject({
      status: 'decided',
      decision: { id: graduatedId, tier: 'limit', outcome: 'intervened' },
    });
    expect(deps.applyHold).toHaveBeenCalledWith(
      'user-2',
      expect.objectContaining({ decisionId: graduatedId }),
      expect.any(Date)
    );
  });

  it('retains graduated holds when an older cached bulk result has no committed receipt', async () => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
    } as Partial<AutoContainmentConfig>);
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    const original = structuredClone(stored[0]);
    const { committedUserIds: _receipt, ...legacy } = bulkResult;
    deps.contain.mockResolvedValue(legacy);
    await applyAutoContainment(assessment, deps);
    expect(deps.releaseContainedHolds).not.toHaveBeenCalled();
    expect(stored[0]).toEqual(original);
  });

  it('keeps the original decision available for release when automatic lifting fails', async () => {
    const { deps, stored } = makeDeps({
      mode: 'enforce',
      tiers: { limit: { mode: 'enforce', minConfidence: 0.7, rolloutPercent: 100 } },
    } as Partial<AutoContainmentConfig>);
    await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    const original = structuredClone(stored[0]);
    deps.releaseContainedHolds.mockRejectedValue(new Error('release transaction unavailable'));
    expect(await applyAutoContainment(assessment, deps)).toMatchObject({
      status: 'decided',
      decision: { outcome: 'contained' },
    });
    expect(stored[0]).toEqual(original);
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('never lets a graduated run reclaim a capped Contain decision on the revision', async () => {
    const { deps, stored, advance } = makeDeps(config, false);
    await applyAutoContainment(assessment, deps);
    expect(stored[0]).toMatchObject({ tier: 'contain', outcome: 'capped' });
    vi.mocked(deps.takeHourlySlot).mockResolvedValue(true);
    advance(2 * 60 * 60 * 1000);

    const run = await applyAutoContainment({ ...assessment, confidence: 0.8 }, deps);
    expect(run).toEqual({ status: 'skipped', reason: 'already_decided' });
    expect(stored[0]).toMatchObject({ tier: 'contain', outcome: 'capped' });
  });
});

describe('applyAutoContainment graduated verdict landing mid-apply', () => {
  beforeEach(() => vi.clearAllMocks());
  const config = {
    mode: 'enforce',
    tiers: { holdGrant: { mode: 'enforce', rolloutPercent: 100 } },
  } as Partial<AutoContainmentConfig>;
  const holding = { ...detection, wouldAction: 'confirmHold' as const };

  it('lifts the holds it just applied when a legitimate verdict landed meanwhile', async () => {
    const { deps, stored } = makeDeps(config);
    vi.mocked(deps.findDetection)
      .mockResolvedValueOnce(holding)
      .mockResolvedValueOnce(holding)
      .mockResolvedValueOnce({ ...holding, verdict: 'legitimate_human' });
    await applyAutoContainment(assessment, deps);
    expect(deps.applyHold).toHaveBeenCalledTimes(1);
    expect(deps.releaseHold).toHaveBeenCalledWith('user-1', stored[0].id);
    expect(deps.decisions.release).toHaveBeenCalledWith(
      stored[0].id,
      expect.objectContaining({ condition: 'legitimate_verdict' })
    );
    expect(stored[0].outcome).toBe('released');
  });

  it('keeps the holds on a confirmed_abuse verdict', async () => {
    const { deps } = makeDeps(config);
    vi.mocked(deps.findDetection)
      .mockResolvedValueOnce(holding)
      .mockResolvedValueOnce(holding)
      .mockResolvedValueOnce({ ...holding, verdict: 'confirmed_abuse' });
    await applyAutoContainment(assessment, deps);
    expect(deps.releaseHold).not.toHaveBeenCalled();
  });
});

describe('applyAutoContainment link rules', () => {
  beforeEach(() => vi.clearAllMocks());

  const limitDetection: ShadowDetectionItem = { ...detection, wouldAction: 'limit', userIds: ['user-1', 'user-2'] };
  const abstained: AbuseAssessmentItem = { ...assessment, result: 'insufficient_evidence', confidence: 0.55 };
  const shadowLimit = {
    mode: 'shadow',
    tiers: { limit: { mode: 'shadow', rolloutPercent: 100 } },
  } as Partial<AutoContainmentConfig>;
  const firing: LinkRuleFacts = {
    userId: 'user-1',
    paying: false,
    partnerDomain: false,
    creditsSpent: 25,
    ownedDomainCluster: null,
    adminHeldDomain: null,
    bannedSameDevice: 1,
  };

  it('records a shadow would_intervene with the rule, the decider and the model judgment it overrode', async () => {
    const { deps, stored } = makeDeps(shadowLimit);
    vi.mocked(deps.findDetection).mockResolvedValue(limitDetection);
    deps.loadLinkRuleFacts.mockResolvedValue([firing, { ...firing, userId: 'user-2', bannedSameDevice: 0 }]);

    const run = await applyAutoContainment(abstained, deps);

    expect(run).toMatchObject({ status: 'decided', decision: { tier: 'limit', outcome: 'would_intervene' } });
    expect(stored[0]).toMatchObject({
      tier: 'limit',
      userIds: ['user-1'],
      decidedBy: 'link_rule',
      linkRules: ['bannedSameDevice'],
      modelJudgment: { result: 'insufficient_evidence', confidence: 0.55 },
      policyVersion: INTERVENTION_POLICY_VERSION,
    });
    expect(deps.loadLinkRuleFacts).toHaveBeenCalledWith(['user-1', 'user-2'], expect.anything());
    expect(deps.applyHold).not.toHaveBeenCalled();
  });

  it('records the model judgment and decider on a model-decided graduated row too', async () => {
    const { deps, stored } = makeDeps(shadowLimit);
    vi.mocked(deps.findDetection).mockResolvedValue(limitDetection);
    await applyAutoContainment(assessment, deps);
    expect(stored[0]).toMatchObject({
      decidedBy: 'model',
      linkRules: [],
      modelJudgment: { result: 'abuse', confidence: 0.97 },
    });
  });

  it('does not load facts when link rules are disabled or the detection is already reviewed', async () => {
    const disabled = makeDeps({ ...shadowLimit, linkRules: { enabled: false } });
    vi.mocked(disabled.deps.findDetection).mockResolvedValue(limitDetection);
    expect(await applyAutoContainment(abstained, disabled.deps)).toEqual({ status: 'skipped', reason: 'not_abuse' });
    expect(disabled.deps.loadLinkRuleFacts).not.toHaveBeenCalled();

    const reviewed = makeDeps(shadowLimit);
    vi.mocked(reviewed.deps.findDetection).mockResolvedValue({ ...limitDetection, verdict: 'legitimate_human' });
    await applyAutoContainment(abstained, reviewed.deps);
    expect(reviewed.deps.loadLinkRuleFacts).not.toHaveBeenCalled();
  });

  it('does not load facts when both rule tiers are off', async () => {
    const tiersOff = makeDeps({
      mode: 'shadow',
      tiers: { limit: { mode: 'off' }, holdGrant: { mode: 'off' } },
    } as Partial<AutoContainmentConfig>);
    vi.mocked(tiersOff.deps.findDetection).mockResolvedValue(limitDetection);
    await applyAutoContainment(abstained, tiersOff.deps);
    expect(tiersOff.deps.loadLinkRuleFacts).not.toHaveBeenCalled();
  });

  it('keeps the model skip when the fact load throws', async () => {
    const { deps, stored } = makeDeps(shadowLimit);
    vi.mocked(deps.findDetection).mockResolvedValue(limitDetection);
    deps.loadLinkRuleFacts.mockRejectedValue(new Error('db down'));
    expect(await applyAutoContainment(abstained, deps)).toEqual({ status: 'skipped', reason: 'not_abuse' });
    expect(stored).toHaveLength(0);
    expect(deps.logger.error).toHaveBeenCalled();
  });
});
