import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AutoContainmentConfigSchema,
  RISK_EVIDENCE_VERSION,
  type AbuseAssessmentItem,
  type AutoContainmentConfig,
  type AutoContainmentDecisionItem,
  type ShadowDetectionItem,
} from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  autoContainmentDecisionRepository: {},
  cacheRepository: {},
  shadowDetectionRepository: {},
}));
vi.mock('@server/admin/usersBulk/adapters', () => ({ usersBulkExecuteDepsFor: vi.fn(), usersBulkResolveDeps: {} }));
vi.mock('@server/admin/usersBulk/execute', () => ({ executeAdminUsersBulk: vi.fn() }));
vi.mock('@server/utils/systemAuditWriter', () => ({ systemAuditWriter: vi.fn() }));

import { applyAutoContainment, type AutoContainmentDeps } from './executor';

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

function makeDeps(config: Partial<AutoContainmentConfig> = {}, slot = true) {
  const stored: AutoContainmentDecisionItem[] = [];
  const deps = {
    loadConfig: vi.fn(async () => AutoContainmentConfigSchema.parse(config)),
    findDetection: vi.fn(async () => detection),
    decisions: {
      findByDetectionId: vi.fn(async (id: string) => stored.find(row => row.detectionId === id) ?? null),
      recordOnce: vi.fn(async (input: Omit<AutoContainmentDecisionItem, 'id'>) => {
        if (stored.some(row => row.detectionId === input.detectionId)) return null;
        const row = { ...input, id: `decision-${stored.length + 1}` };
        stored.push(row);
        return row;
      }),
      finish: vi.fn(async () => undefined),
    },
    takeHourlySlot: vi.fn(async () => slot),
    contain: vi.fn(async () => bulkResult),
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies AutoContainmentDeps;
  return { deps, stored };
}

describe('applyAutoContainment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a would_contain decision in shadow mode (the default) and touches no account', async () => {
    const { deps } = makeDeps();
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({
      status: 'decided',
      decision: { mode: 'shadow', outcome: 'would_contain', userIds: ['user-1'] },
    });
    expect(deps.contain).not.toHaveBeenCalled();
    expect(deps.decisions.finish).not.toHaveBeenCalled();
  });

  it('contains through the bulk path in enforce mode, with the evidence as the reason', async () => {
    const { deps } = makeDeps({ mode: 'enforce', blockEmailDomains: true });
    const run = await applyAutoContainment(assessment, deps);
    expect(deps.decisions.recordOnce).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'pending' }));
    expect(deps.contain).toHaveBeenCalledWith({
      userIds: ['user-1'],
      reason: expect.stringContaining('abuse assessment assessment-1'),
      idempotencyKey: 'auto-containment:detection-1',
      blockEmailDomains: true,
    });
    expect(deps.decisions.finish).toHaveBeenCalledWith('detection-1', {
      outcome: 'contained',
      batchId: 'batch-1',
      error: null,
    });
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'contained', batchId: 'batch-1' } });
  });

  it('records failed when the bulk path fails for an account or throws', async () => {
    const { deps } = makeDeps({ mode: 'enforce' });
    deps.contain.mockResolvedValueOnce({
      ...bulkResult,
      applied: 0,
      failed: [{ userId: 'user-1', error: 'write conflict' }],
    });
    await applyAutoContainment(assessment, deps);
    expect(deps.decisions.finish).toHaveBeenLastCalledWith('detection-1', {
      outcome: 'failed',
      batchId: 'batch-1',
      error: '1 account(s) failed: write conflict',
    });

    const second = makeDeps({ mode: 'enforce' });
    second.deps.contain.mockRejectedValueOnce(new Error('db down'));
    await applyAutoContainment(assessment, second.deps);
    expect(second.deps.decisions.finish).toHaveBeenLastCalledWith('detection-1', {
      outcome: 'failed',
      batchId: null,
      error: 'db down',
    });
    expect(second.deps.logger.error).toHaveBeenCalled();
  });

  it('records capped and acts on nothing once the hourly window is spent', async () => {
    const { deps } = makeDeps({ mode: 'enforce' }, false);
    const run = await applyAutoContainment(assessment, deps);
    expect(run).toMatchObject({ status: 'decided', decision: { outcome: 'capped' } });
    expect(deps.contain).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('decides each detection once, without spending another slot', async () => {
    const { deps } = makeDeps({ mode: 'enforce' });
    await applyAutoContainment(assessment, deps);
    const again = await applyAutoContainment({ ...assessment, id: 'assessment-2' }, deps);
    expect(again).toEqual({ status: 'skipped', reason: 'already_decided' });
    expect(deps.takeHourlySlot).toHaveBeenCalledTimes(1);
    expect(deps.contain).toHaveBeenCalledTimes(1);
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
    missing.deps.findDetection.mockResolvedValueOnce(null as unknown as ShadowDetectionItem);
    expect(await applyAutoContainment(assessment, missing.deps)).toEqual({
      status: 'skipped',
      reason: 'detection_not_found',
    });
    for (const { deps } of [weak, reviewed, missing]) expect(deps.contain).not.toHaveBeenCalled();
  });
});
