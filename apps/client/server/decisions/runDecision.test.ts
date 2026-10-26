import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveKey, callableProviders, registeredModels, providerSpy, recordUsage, reserve, refund, settle } =
  vi.hoisted(() => ({
    resolveKey: vi.fn(),
    callableProviders: vi.fn(),
    registeredModels: { value: ['test-decisions', 'gpt-6-luna'] as string[] },
    providerSpy: vi.fn(),
    recordUsage: vi.fn(),
    reserve: vi.fn(),
    refund: vi.fn(),
    settle: vi.fn(),
  }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  usageEventRepository: { record: (...a: unknown[]) => recordUsage(...a) },
}));
vi.mock('@bike4mind/utils', async importActual => ({
  ...(await importActual<typeof import('@bike4mind/utils')>()),
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: vi.fn(() => true),
}));
vi.mock('@server/billing/reserveRequestCredits', () => ({ reserveRequestCredits: (...a: unknown[]) => reserve(...a) }));
// The real TestDecisionProvider behind a spy, so the runner exercises the real retry policy.
vi.mock('@bike4mind/server-utils/decisions/providers', async () => {
  const { TestDecisionProvider } = await import('@bike4mind/utils/decisionProviders');
  const real = new TestDecisionProvider();
  const provider = {
    id: 'test',
    models: ['test-decisions'],
    decide: async (...a: Parameters<typeof real.decide>) => (await providerSpy(...a)) ?? real.decide(...a),
  };
  return {
    getDecisionProviderRegistry: () => ({
      forModel: (model: string) => (registeredModels.value.includes(model) ? provider : undefined),
      models: () => registeredModels.value,
    }),
    resolveDecisionProviderKey: (...a: unknown[]) => resolveKey(...a),
    resolveCallableDecisionProviders: (...a: unknown[]) => callableProviders(...a),
  };
});
vi.mock('@server/files/loadAccessibleFabFile', () => ({ loadAccessibleFabFile: vi.fn() }));
vi.mock('@bike4mind/utils/imageResize', () => ({ ensureImageWithinDimensionLimit: vi.fn(async (b: Buffer) => b) }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ download: vi.fn() }) }));

import { getSettingsMap } from '@bike4mind/utils';
import { TEST_DECISION_MARKERS } from '@bike4mind/utils/decisionProviders';
import { runDecision } from './runDecision';

const QUESTIONS = [
  { type: 'predicate', name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  {
    type: 'choice',
    name: 'team',
    instructions: 'Which team?',
    choices: [{ value: 'billing' }, { value: 'technical' }],
  },
];

const caller = () => ({
  userId: 'u1',
  user: { id: 'u1' } as never,
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never,
  source: 'agent' as const,
});

const run = (body: Record<string, unknown> = {}) =>
  runDecision({ caller: caller(), body: { input: 'Payouts failing', questions: QUESTIONS, ...body } });

describe('runDecision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registeredModels.value = ['test-decisions', 'gpt-6-luna'];
    resolveKey.mockResolvedValue('test-key');
    callableProviders.mockResolvedValue(new Set(['test']));
    recordUsage.mockResolvedValue(undefined);
    settle.mockImplementation(async (credits: number) => credits);
    reserve.mockResolvedValue({ ownerId: 'u1', ownerType: CreditHolderType.User, reservedCredits: 1, refund, settle });
  });

  it('reserves the worst-case cost, settles the stochastic cost and records one decision usage event', async () => {
    const response = await run();

    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ featureLabel: 'decisions', enforceCredits: true }));
    expect(settle).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ type: 'decision_usage', source: 'agent' })
    );
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'decision', provider: 'test', status: 'ok', source: 'agent' })
    );
    expect(response.answers.map(answer => answer.name)).toEqual(['is_urgent', 'team']);
  });

  it('reads enforceCredits past the settings cache so an admin flip applies on the next call', async () => {
    await run();
    expect(getSettingsMap).toHaveBeenCalledWith(expect.anything(), { names: ['enforceCredits'], skipCache: true });
  });

  it('refunds on a provider failure and records an error usage row with zero tokens', async () => {
    providerSpy.mockRejectedValueOnce(new Error('adapter bug'));
    await expect(run()).rejects.toThrow('adapter bug');

    expect(refund).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', inputTokens: 0, outputTokens: 0, creditsCharged: 0 })
    );
  });

  it('refunds when the input cannot be resolved', async () => {
    const { NotFoundError } = await import('@bike4mind/utils');
    const { loadAccessibleFabFile } = await import('@server/files/loadAccessibleFabFile');
    vi.mocked(loadAccessibleFabFile).mockRejectedValue(new NotFoundError('nope'));

    await expect(run({ input: [{ type: 'image', file_id: '64b7f0c2a1b2c3d4e5f60718' }] })).rejects.toThrow();
    expect(refund).toHaveBeenCalledTimes(1);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('retries once on the same model, never a second one, then surfaces provider_overloaded', async () => {
    await expect(run({ input: TEST_DECISION_MARKERS.overloaded })).rejects.toMatchObject({
      name: 'DecisionOverloadedError',
    });

    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(providerSpy.mock.calls.every(([request]) => request.model === 'test-decisions')).toBe(true);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it('picks the first callable model when the caller omits one', async () => {
    callableProviders.mockResolvedValue(new Set(['test']));
    const response = await run();

    expect(callableProviders).toHaveBeenCalledWith('u1', expect.arrayContaining(['test']), expect.anything());
    expect(response.model).toBe('test-decisions');
  });

  it('refuses provider_not_configured without reserving when no key resolves', async () => {
    resolveKey.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({ errorCode: 'provider_not_configured', status: 503 });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('preserves the key policy and an explicit personal workspace through the billing seam', async () => {
    const apiKeyInfo = { keyId: 'key-1', scopes: [ApiKeyScope.AI_CHAT], billingOwnerType: CreditHolderType.User };
    await runDecision({
      caller: { ...caller(), apiKeyId: 'key-1', apiKeyInfo, billingOrganizationId: null },
      body: { input: 'text', questions: QUESTIONS },
    });
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({ apiKeyInfo }),
        billingOrganizationId: null,
      })
    );
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: 'key-1' }));
  });

  it('refuses model_unavailable for a model this deployment does not serve', async () => {
    await expect(run({ model: 'gpt-nope' })).rejects.toMatchObject({
      errorCode: 'model_unavailable',
      param: 'model',
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('refuses provider_not_configured when no model is callable and none was named', async () => {
    callableProviders.mockResolvedValue(new Set());
    await expect(run()).rejects.toMatchObject({ errorCode: 'provider_not_configured', status: 503 });
  });

  it('rejects a malformed tool request before any provider or credit work', async () => {
    // A model-authored argument can be any JSON: an empty question list fails the shared schema.
    await expect(run({ questions: [] })).rejects.toMatchObject({ errorCode: 'invalid_request', status: 422 });
    expect(reserve).not.toHaveBeenCalled();
    expect(providerSpy).not.toHaveBeenCalled();
  });
});
