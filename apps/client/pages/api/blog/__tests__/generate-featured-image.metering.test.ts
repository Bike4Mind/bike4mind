// @vitest-environment node
/**
 * POST /api/blog/generate-featured-image runs a caller-picked image model on the platform key, so
 * it must hold the estimated credits before the provider call and settle the priced image after.
 * The real reserveRequestCredits + image price tables run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/utils';
import { insufficientCreditsError, usdToCredits } from '@bike4mind/common';
import { computeImageUsdCostPerImage } from '@bike4mind/services/imageCost';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  generate: vi.fn(),
  record: vi.fn(async () => undefined),
  assertAdmission: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  apiKeyRepository: {},
  usageEventRepository: { record: m.record },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
  aiImageService: () => ({ generate: m.generate }),
}));
vi.mock('@bike4mind/services', () => ({
  creditService: { holdCredits: m.hold, releaseCreditHold: m.release, settleCreditHold: m.settleHold },
  organizationService: {},
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({ openai: 'sk-test' }) },
  latchUsage: () => undefined,
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: m.assertAdmission }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 0 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [
    { id: 'gpt-image-1', type: 'image' },
    { id: 'mystery-image-model', type: 'image' },
  ],
}));
vi.mock('@client/services/operationsModelService', () => ({ OperationsModelService: {} }));
vi.mock('@server/utils/imageLogger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('axios', () => ({
  default: { get: async () => ({ data: Buffer.from('png'), headers: { 'content-type': 'image/png' } }) },
}));

const { default: handler } = await import('@pages/api/blog/generate-featured-image');

async function call(imageModel = 'gpt-image-1') {
  const { req, res } = createMocks({ method: 'POST', body: { imagePrompt: 'a bicycle at dawn', imageModel } });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 500 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.generate.mockResolvedValue(['https://provider.example/image.png']);
  m.assertAdmission.mockResolvedValue(undefined);
});

describe('POST /api/blog/generate-featured-image metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.generate).not.toHaveBeenCalled();
  });

  it('refuses a model admission rejects before reserving or calling the provider', async () => {
    m.assertAdmission.mockRejectedValue(new ForbiddenError('Model "gpt-image-1" is not accessible'));

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.assertAdmission).toHaveBeenCalledWith('gpt-image-1');
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.generate).not.toHaveBeenCalled();
  });

  it('holds the estimate and charges a funded caller the priced image once', async () => {
    const expectedCredits = usdToCredits(
      computeImageUsdCostPerImage('gpt-image-1', { model: 'gpt-image-1', size: '1024x1024', quality: 'high' })
    );

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.hold).toHaveBeenCalledBefore(m.generate);
    expect(m.hold).toHaveBeenCalledWith(
      expect.objectContaining({ requiredCredits: expectedCredits }),
      expect.anything()
    );
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(m.settleHold).toHaveBeenCalledWith(
      expect.anything(),
      expectedCredits,
      expect.objectContaining({ type: 'image_generation_usage', model: 'gpt-image-1' }),
      expect.anything(),
      expect.anything()
    );
    expect(m.record).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'image_generation', model: 'gpt-image-1', creditsCharged: expectedCredits })
    );
  });

  it('refunds the hold when the provider throws', async () => {
    m.generate.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res._getStatusCode()).toBe(500);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('fails closed with 400 for a model it cannot price while credits are enforced', async () => {
    const res = await call('mystery-image-model');

    expect(res._getStatusCode()).toBe(400);
    expect(m.generate).not.toHaveBeenCalled();
    expect(m.hold).not.toHaveBeenCalled();
  });

  it('runs without any hold when credits are not enforced, even for an unpriced model', async () => {
    m.enforce = false;

    expect((await call())._getStatusCode()).toBe(200);
    expect((await call('mystery-image-model'))._getStatusCode()).toBe(200);
    expect(m.generate).toHaveBeenCalledTimes(2);
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.settleHold).not.toHaveBeenCalled();
  });
});
