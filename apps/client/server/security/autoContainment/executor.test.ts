import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoContainmentConfigSchema,
  RISK_EVIDENCE_VERSION,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentDecisionItem,
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
}));
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkExecuteDepsFor: h.depsFor, usersBulkResolveDeps: {} }));
vi.mock('@server/admin/usersBulk/execute', () => ({ executeAdminUsersBulk: h.execute }));
vi.mock('@server/admin/usersBulk/resolve', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/admin/usersBulk/resolve')>()),
  resolveAdminUsersBulk: h.resolve,
}));
vi.mock('@server/utils/systemAuditWriter', () => ({ systemAuditWriter: h.writer }));

import { cohortHashOf } from '@server/admin/usersBulk/resolve';
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

/** An in-memory decisions store with the repository's claim semantics (unique pair, atomic reclaim). */
function makeDecisions() {
  const stored: Row[] = [];
  return {
    stored,
    listForDetection: vi.fn(async (detectionId: string) => stored.filter(row => row.detectionId === detectionId)),
    recordOnce: vi.fn(async (input: Omit<Row, 'id'>) => {
      if (stored.some(row => row.detectionId === input.detectionId && row.revision === input.revision)) return null;
      const row = { ...input, id: `decision-${stored.length + 1}` };
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
    finish: vi.fn(async (id: string, patch: Pick<Row, 'outcome' | 'batchId' | 'error'>) => {
      const row = stored.find(candidate => candidate.id === id);
      if (row) Object.assign(row, patch);
    }),
  };
}

function makeDeps(config: Partial<AutoContainmentConfig> = {}, slot = true, decisions = makeDecisions()) {
  let now = NOW;
  const deps = {
    loadConfig: vi.fn(async () => AutoContainmentConfigSchema.parse(config)),
    findDetection: vi.fn(async (): Promise<ShadowDetectionItem | null> => detection),
    decisions,
    takeHourlySlot: vi.fn(async (_mode: Row['mode'], _maxPerHour: number) => slot),
    contain: vi.fn(async (): Promise<typeof bulkResult | null> => bulkResult),
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
    expect(h.resolve).toHaveBeenCalledWith({ kind: 'ids', userIds: request.userIds }, [], {}, expect.any(Date));
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
      { id: AUTO_CONTAINMENT_ACTOR_ID, selfIds: [] },
      { marker: 'execute-deps' }
    );
  });

  it('returns null and runs nothing when no account is eligible', async () => {
    h.resolve.mockResolvedValue({ eligible: [] });
    expect(await containAsSystem()(request)).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });
});
