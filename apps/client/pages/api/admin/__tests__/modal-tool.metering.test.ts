// @vitest-environment node
/**
 * POST /api/admin/modal-tool parses the admin's query with the operations model on the platform key and
 * bills the calling admin: hold before the provider call, settle after. A credit refusal is a 422, not
 * a silent fallback to pattern matching. The real meterPlatformCompletion + reserveRequestCredits
 * run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  record: vi.fn(async () => undefined),
  complete: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => unknown) => fn,
  }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@client/server/tools/modalOperations', () => ({
  collectModalChanges: async (run: () => Promise<unknown>) => ({ result: await run(), changes: [] }),
  createModal: vi.fn(),
  updateModal: vi.fn(),
  listModals: async () => ({ success: true, data: [] }),
  deleteModal: vi.fn(),
}));
vi.mock('@client/server/tools/recordModalChanges', () => ({ recordModalChanges: async () => undefined }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  apiKeyRepository: {},
  adminSettingsRepository: {},
  usageEventRepository: { record: m.record },
  creditTransactionRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
  getSettingsValue: (name: string) => (name === 'enforceCredits' ? m.enforce : undefined),
}));
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services'))
    .meterCompletionBackend,
  creditService: { holdCredits: m.hold, releaseCreditHold: m.release, settleCreditHold: m.settleHold },
  organizationService: {},
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  latchUsage: (u: Record<string, number>, info?: Record<string, number>) => {
    if (info?.inputTokens) u.inputTokens = info.inputTokens;
    if (info?.outputTokens) u.outputTokens = info.outputTokens;
  },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', () => ({
  loadModelConfigurations: async () => [],
  createModelAdmission: () => ({ admits: async () => true, assert: async () => undefined }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));

const MODEL = { id: 'ops-model', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: async () => [MODEL],
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({ modelId: MODEL.id, modelInfo: MODEL, llm: { complete: m.complete } }),
  },
}));

const { default: handler, parseNaturalLanguageQueryDirect } = await import('@pages/api/admin/modal-tool');

async function call() {
  const { req, res } = createMocks({ method: 'POST', body: { query: 'what banners do we have?' } });
  Object.assign(req, {
    ability: { can: () => true },
    user: { id: 'admin1', isAdmin: true, tags: [], groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'admin1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['{"action":"list","parameters":{}}']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/admin/modal-tool metering', () => {
  it('bills the calling admin: holds before the provider call and settles once', async () => {
    const res = await call();

    expect(res._getJSONData()).toMatchObject({ success: true });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('surfaces a credit refusal as 422 and does not fall back to pattern parsing', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('still falls back to pattern parsing when the provider fails after the hold', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.release).toHaveBeenCalledOnce();
  });

  it('meters the tool-server entry point through the meter it is given', async () => {
    const meter = vi.fn().mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(parseNaturalLanguageQueryDirect('list modals', {}, meter)).rejects.toMatchObject({ statusCode: 422 });
    expect(meter).toHaveBeenCalledOnce();
    expect(m.complete).not.toHaveBeenCalled();
  });
});
