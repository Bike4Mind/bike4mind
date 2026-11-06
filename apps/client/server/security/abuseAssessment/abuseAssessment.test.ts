import {
  ABUSE_ASSESSMENT_MAX_ATTEMPTS,
  AbuseAssessmentConfigSchema,
  type AbuseAssessmentItem,
  type ShadowDetectionItem,
} from '@bike4mind/common';
import { DecisionProviderError } from '@bike4mind/utils/decisionProviders';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: { enabled: true, config: {} as Record<string, unknown> },
  providerDecide: vi.fn(),
  platformKey: vi.fn(),
  userKey: vi.fn(),
  reserveRequestCredits: vi.fn(),
  findDetection: vi.fn(),
  listUnreviewed: vi.fn(),
  addVerdict: vi.fn(),
  findSummaries: vi.fn(),
  findByCacheKey: vi.fn(),
  save: vi.fn(),
  callCap: vi.fn(),
  spend: vi.fn(),
  claimDedup: vi.fn(),
  acquireLease: vi.fn(),
}));

vi.mock('@bike4mind/utils', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: (key: string) =>
    key === 'abuseAssessmentEnabled' ? mocks.settings.enabled : mocks.settings.config,
}));
vi.mock('@bike4mind/database', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/database')>()),
  adminSettingsRepository: {},
  shadowDetectionRepository: {
    findById: mocks.findDetection,
    listUnreviewedSince: mocks.listUnreviewed,
    addVerdict: mocks.addVerdict,
  },
  // Only the read the summary needs: any write to an account would fail on a missing method.
  userRepository: { findRiskEvidenceSummaries: mocks.findSummaries },
  abuseAssessmentRepository: { findByCacheKey: mocks.findByCacheKey, save: mocks.save },
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: mocks.callCap,
    tryAddWithinLimitFixedWindow: mocks.spend,
    claimDedup: mocks.claimDedup,
    deleteByKey: vi.fn(async () => true),
    tryAcquireLease: mocks.acquireLease,
    releaseLease: vi.fn(async () => undefined),
  },
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits: mocks.reserveRequestCredits }));
vi.mock('@bike4mind/server-utils/decisions/providers', () => ({
  getDecisionProviderRegistry: () => ({
    forModel: (model: string) =>
      model === 'gpt-6-luna' ? { id: 'openai', models: ['gpt-6-luna'], decide: mocks.providerDecide } : undefined,
    models: () => ['gpt-6-luna'],
  }),
  resolvePlatformDecisionProviderKey: mocks.platformKey,
  resolveDecisionProviderKey: mocks.userKey,
  resolveCallableDecisionProviders: vi.fn(),
}));

import { assessShadowDetection, replayAbuseAssessments, sweepAbuseAssessments } from './abuseAssessment';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const DETECTION_ID = '65f000000000000000000001';

const detection: ShadowDetectionItem = {
  id: DETECTION_ID,
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 signups from one network',
  userIds: ['65f0000000000000000000a1'],
  network: { ip: '203.0.113.7', asn: 64500, asnOrg: 'Example', country: 'ZZ', hosting: true },
  signals: [{ key: 'signups', label: 'Signups', observed: 3, threshold: 3 }],
  windowMinutes: 180,
  detectedAt: new Date('2026-11-01T12:00:00Z'),
  verdict: null,
  verdicts: [],
  revision: 0,
};

const answer = (probabilities: Record<string, number>) => ({
  model: 'gpt-6-luna',
  answers: [{ type: 'choice', probabilities }],
  usage: { inputTokens: 900, outputTokens: 5 },
});

const run = () =>
  assessShadowDetection({ detectionId: DETECTION_ID, trigger: 'admin', requestedBy: 'admin-1', logger });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings.enabled = true;
  mocks.settings.config = AbuseAssessmentConfigSchema.parse({ model: 'gpt-6-luna', dailyBudgetUsd: 1 });
  mocks.platformKey.mockResolvedValue('platform-key');
  mocks.findDetection.mockResolvedValue(detection);
  mocks.findSummaries.mockResolvedValue([]);
  mocks.findByCacheKey.mockResolvedValue(null);
  mocks.callCap.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
  mocks.spend.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
  mocks.claimDedup.mockResolvedValue({ claimed: true });
  mocks.acquireLease.mockResolvedValue(true);
  mocks.providerDecide.mockResolvedValue(
    answer({ abuse: 0.7, legitimate_automation: 0.1, insufficient_evidence: 0.2 })
  );
  mocks.save.mockImplementation(async ({ cacheKey: _cacheKey, ...item }) => ({ id: 'aa1', attempts: 1, ...item }));
});

describe('assessShadowDetection', () => {
  it('records a typed judgment with its versions, paid by the platform and not the assessed user', async () => {
    const outcome = await run();

    expect(outcome).toMatchObject({
      status: 'assessed',
      cached: false,
      item: { result: 'abuse', model: 'gpt-6-luna' },
    });
    const saved = mocks.save.mock.calls[0][0];
    expect(saved).toMatchObject({
      detectionId: DETECTION_ID,
      result: 'abuse',
      failure: null,
      policyVersion: 1,
      evidenceVersion: 1,
      modelVersion: 'gpt-6-luna',
      trigger: 'admin',
      requestedBy: 'admin-1',
    });
    expect(saved.probabilities).toContainEqual({ value: 'abuse', probability: 0.7 });
    expect(mocks.platformKey).toHaveBeenCalledWith('openai', logger);
    expect(mocks.providerDecide.mock.calls[0][1]).toMatchObject({ apiKey: 'platform-key' });
    expect(mocks.userKey).not.toHaveBeenCalled();
    expect(mocks.reserveRequestCredits).not.toHaveBeenCalled();
    expect(mocks.addVerdict).not.toHaveBeenCalled();
  });

  it('sends only the pseudonymous summary to the provider', async () => {
    await run();
    const wire = JSON.stringify(mocks.providerDecide.mock.calls[0][0].input);
    expect(wire).not.toContain('203.0.113.7');
    expect(wire).not.toContain('65f0000000000000000000a1');
    expect(mocks.providerDecide.mock.calls[0][0].safetyIdentifier).toBeUndefined();
  });

  it.each([
    ['disabled', () => (mocks.settings.enabled = false)],
    ['no_model', () => (mocks.settings.config = AbuseAssessmentConfigSchema.parse({}))],
    ['model_not_callable', () => mocks.platformKey.mockResolvedValue(null)],
  ])('makes no provider call when %s', async (reason, arrange) => {
    arrange();
    expect(await run()).toEqual({ status: 'skipped', reason });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses before the provider when the budget or call cap is spent', async () => {
    mocks.spend.mockResolvedValue({ success: false, count: 1_000_000, expiresAt: new Date() });
    expect(await run()).toEqual({ status: 'skipped', reason: 'budget_exhausted' });
    mocks.callCap.mockResolvedValue({ success: false, count: 100, expiresAt: new Date() });
    expect(await run()).toEqual({ status: 'skipped', reason: 'call_cap_reached' });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('meters the worst-case cost against the platform budget in micro-USD', async () => {
    await run();
    const [key, amount, limit] = mocks.spend.mock.calls[0];
    expect(key).toBe('abuseAssessment:spendMicroUsd');
    expect(amount).toBeGreaterThan(0);
    expect(limit).toBe(1_000_000);
  });

  it('returns a cached judgment for unchanged evidence without calling the provider', async () => {
    mocks.findByCacheKey.mockResolvedValue({ result: 'legitimate_automation', attempts: 1 } as AbuseAssessmentItem);
    expect(await run()).toMatchObject({ status: 'assessed', cached: true });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
  });

  it('retries an unknown result until the attempt cap', async () => {
    mocks.findByCacheKey.mockResolvedValue({
      result: 'unknown',
      attempts: 1,
      assessedAt: new Date(),
    } as AbuseAssessmentItem);
    expect(await run()).toMatchObject({ status: 'assessed', item: { result: 'abuse' } });

    mocks.findByCacheKey.mockResolvedValue({
      result: 'unknown',
      attempts: ABUSE_ASSESSMENT_MAX_ATTEMPTS,
      assessedAt: new Date(),
    } as AbuseAssessmentItem);
    expect(await run()).toEqual({ status: 'skipped', reason: 'attempts_exhausted' });
    expect(mocks.providerDecide).toHaveBeenCalledTimes(1);
  });

  it('retries an unknown result one attempt short of the cap and refuses at the cap', async () => {
    mocks.findByCacheKey.mockResolvedValue({
      result: 'unknown',
      attempts: ABUSE_ASSESSMENT_MAX_ATTEMPTS - 1,
      assessedAt: new Date(),
    } as AbuseAssessmentItem);
    expect(await run()).toMatchObject({ status: 'assessed', item: { result: 'abuse' } });
    expect(mocks.providerDecide).toHaveBeenCalledTimes(1);
  });

  it('retries an exhausted unknown once it is more than a day old', async () => {
    mocks.findByCacheKey.mockResolvedValue({
      result: 'unknown',
      attempts: ABUSE_ASSESSMENT_MAX_ATTEMPTS,
      assessedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    } as AbuseAssessmentItem);
    expect(await run()).toMatchObject({ status: 'assessed', item: { result: 'abuse' } });
    expect(mocks.providerDecide).toHaveBeenCalledTimes(1);
  });

  it('returns the judgment another caller stored between the first read and the claim', async () => {
    mocks.findByCacheKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ result: 'abuse', attempts: 1 } as AbuseAssessmentItem);
    expect(await run()).toMatchObject({ status: 'assessed', cached: true, item: { result: 'abuse' } });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('refuses a zero budget without touching the call counter or the provider', async () => {
    mocks.settings.config = AbuseAssessmentConfigSchema.parse({ model: 'gpt-6-luna', dailyBudgetUsd: 0 });
    expect(await run()).toEqual({ status: 'skipped', reason: 'budget_exhausted' });
    expect(mocks.callCap).not.toHaveBeenCalled();
    expect(mocks.providerDecide).not.toHaveBeenCalled();
  });

  it.each([
    [
      'provider_overloaded',
      () => mocks.providerDecide.mockRejectedValue(new DecisionProviderError('overloaded', 'busy', { status: 503 })),
    ],
    [
      'provider_rejected',
      () =>
        mocks.providerDecide.mockRejectedValue(new DecisionProviderError('rejected_key', 'bad key', { status: 401 })),
    ],
    ['malformed_response', () => mocks.providerDecide.mockResolvedValue(answer({ abuse: 0.9, made_up: 0.9 }))],
    ['refused', () => mocks.providerDecide.mockResolvedValue({ ...answer({}), answers: [{ type: 'refusal' }] })],
  ])('stores unknown with %s, never a judgment', async (failure, arrange) => {
    arrange();
    expect(await run()).toMatchObject({ status: 'assessed', item: { result: 'unknown', failure, probabilities: [] } });
  });

  it('skips a detection another run is already assessing', async () => {
    mocks.claimDedup.mockResolvedValue({ claimed: false });
    expect(await run()).toEqual({ status: 'skipped', reason: 'in_flight' });
    mocks.claimDedup.mockResolvedValue({ claimed: true });
    mocks.acquireLease.mockResolvedValue(false);
    expect(await run()).toEqual({ status: 'skipped', reason: 'busy' });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
  });

  it('assesses without group evidence when its producer fails', async () => {
    const outcome = await assessShadowDetection({
      detectionId: DETECTION_ID,
      trigger: 'admin',
      requestedBy: null,
      logger,
      deps: { groupEvidence: async () => Promise.reject(new Error('cluster store down')) },
    });
    expect(outcome).toMatchObject({ status: 'assessed', item: { featureSummary: { group: null } } });
  });

  it('logs and skips group evidence of an invalid shape, still assessing', async () => {
    const warn = vi.fn();
    const outcome = await assessShadowDetection({
      detectionId: DETECTION_ID,
      trigger: 'admin',
      requestedBy: null,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      deps: { groupEvidence: async () => ({ unexpectedKey: 1 }) as never },
    });
    expect(outcome).toMatchObject({ status: 'assessed', item: { featureSummary: { group: null } } });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('sweepAbuseAssessments', () => {
  it('does nothing until the sweep and a rollout are configured', async () => {
    expect(await sweepAbuseAssessments({ logger })).toEqual({ status: 'disabled' });
    expect(mocks.listUnreviewed).not.toHaveBeenCalled();
  });

  it('stops the run once the budget is spent', async () => {
    mocks.settings.config = AbuseAssessmentConfigSchema.parse({
      model: 'gpt-6-luna',
      dailyBudgetUsd: 1,
      sweepEnabled: true,
      sweepRolloutPercent: 100,
    });
    mocks.listUnreviewed.mockResolvedValue([detection, { ...detection, id: '65f000000000000000000002' }]);
    mocks.spend.mockResolvedValue({ success: false, count: 0, expiresAt: new Date() });

    const result = await sweepAbuseAssessments({ logger });
    expect(result).toMatchObject({ status: 'stopped', skipped: { budget_exhausted: 1 } });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
  });

  describe('with the sweep on', () => {
    const OTHER_ID = '65f000000000000000000002';
    const sweepConfig = (maxAssessmentsPerSweep: number) =>
      AbuseAssessmentConfigSchema.parse({
        model: 'gpt-6-luna',
        dailyBudgetUsd: 1,
        sweepEnabled: true,
        sweepRolloutPercent: 100,
        maxAssessmentsPerSweep,
      });

    beforeEach(() => {
      mocks.listUnreviewed.mockResolvedValue([detection, { ...detection, id: OTHER_ID }]);
    });

    it('counts only fresh assessments toward the cap, so a cache hit does not crowd out older ones', async () => {
      mocks.settings.config = sweepConfig(1);
      mocks.findByCacheKey.mockResolvedValueOnce({ result: 'abuse', attempts: 1 } as AbuseAssessmentItem);

      const result = await sweepAbuseAssessments({ logger });

      expect(result).toMatchObject({ status: 'success', considered: 2, cached: 1, assessed: 1, errors: 0 });
      expect(mocks.providerDecide).toHaveBeenCalledTimes(1);
    });

    it('counts a failing detection as an error and carries on with the next', async () => {
      mocks.settings.config = sweepConfig(5);
      mocks.findDetection.mockRejectedValueOnce(new Error('db down'));

      const result = await sweepAbuseAssessments({ logger });

      expect(result).toMatchObject({ status: 'success', considered: 2, errors: 1, assessed: 1 });
    });

    it('hands every judgment, cached included, to afterAssessment and survives its failure', async () => {
      mocks.settings.config = sweepConfig(5);
      mocks.findByCacheKey.mockResolvedValueOnce({ result: 'abuse', attempts: 1 } as AbuseAssessmentItem);
      const afterAssessment = vi.fn().mockRejectedValueOnce(new Error('contain failed')).mockResolvedValue(undefined);

      const result = await sweepAbuseAssessments({ logger, deps: { afterAssessment } });

      expect(afterAssessment).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ status: 'success', considered: 2, cached: 1, assessed: 1, errors: 1 });
    });

    it('stops when settings reloaded after a fresh assessment show the feature off', async () => {
      mocks.settings.config = sweepConfig(5);
      mocks.providerDecide.mockImplementation(async () => {
        mocks.settings.enabled = false;
        return answer({ abuse: 0.7, legitimate_automation: 0.1, insufficient_evidence: 0.2 });
      });

      const result = await sweepAbuseAssessments({ logger });

      expect(result).toMatchObject({ status: 'stopped', considered: 1, assessed: 1 });
      expect(mocks.providerDecide).toHaveBeenCalledTimes(1);
    });
  });
});

describe('replayAbuseAssessments', () => {
  it('stops with no_model, without a provider call, when enabled with a budget but no model configured', async () => {
    mocks.settings.config = AbuseAssessmentConfigSchema.parse({ model: null, dailyBudgetUsd: 1 });
    const result = await replayAbuseAssessments({
      examples: [{ id: DETECTION_ID, label: null, summary: {} as never }],
      models: ['gpt-6-luna'],
      logger,
    });
    expect(result).toEqual({ status: 'stopped', reason: 'no_model', rows: [] });
    expect(mocks.providerDecide).not.toHaveBeenCalled();
  });

  it('returns per-example outputs next to the label without storing them', async () => {
    const summary = (await run()).status === 'assessed' ? mocks.save.mock.calls[0][0].featureSummary : null;
    mocks.save.mockClear();

    const result = await replayAbuseAssessments({
      examples: [{ id: DETECTION_ID, label: 'confirmed_abuse', summary }],
      models: ['gpt-6-luna'],
      logger,
    });
    expect(result).toEqual({
      status: 'completed',
      reason: null,
      rows: [expect.objectContaining({ exampleId: DETECTION_ID, label: 'confirmed_abuse', result: 'abuse' })],
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
