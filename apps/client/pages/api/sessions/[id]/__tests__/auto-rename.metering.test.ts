// @vitest-environment node
/**
 * POST /api/sessions/[id]/auto-rename runs the operations model on the platform key, so it must hold
 * credits before the provider call, settle after, and surface a credit refusal as 422 instead of the
 * blanket 500. The real meterPlatformCompletion + reserveRequestCredits
 * run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { insufficientCreditsError } from '@bike4mind/common';
import { UnprocessableEntityError } from '@bike4mind/common';

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
    post: (h: (req: unknown, res: unknown) => Promise<unknown>) => async (req: unknown, res: unknown) => h(req, res),
  }),
}));
vi.mock('@server/utils/withRequestCompletionQuota', () => ({
  withRequestCompletionQuota:
    (fn: (req: unknown, res: unknown, ctx: unknown) => unknown) => (req: unknown, res: unknown) =>
      fn(req, res, { track: <T>(p: T) => p }),
}));
vi.mock('@bike4mind/server-utils/utils/sessionAccess', () => ({ assertSessionAccess: vi.fn() }));
vi.mock('@server/auth/assertAiAccessAllowed', () => ({ assertAiAccessAllowed: vi.fn() }));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  questRepository: {},
  sessionRepository: {},
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
  sessionService: {
    autoName: async (_input: unknown, deps: { createCompletion: (prompt: string) => Promise<string> }) => ({
      id: 's1',
      name: await deps.createCompletion('name this'),
    }),
  },
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

const { default: handler } = await import('@pages/api/sessions/[id]/auto-rename');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() };

async function call() {
  const { req, res } = createMocks({ method: 'POST', query: { id: 's1' } });
  Object.assign(req, { user: { id: 'u1', tags: [], groups: [] }, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.hold.mockResolvedValue({ ownerId: 'u1', ownerType: 'user', reservedCredits: 1 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['Quarterly Planning']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/sessions/[id]/auto-rename metering', () => {
  it('holds before the provider call and settles the priced usage once', async () => {
    const res = await call();

    expect(res._getJSONData()).toMatchObject({ name: 'Quarterly Planning' });
    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.settleHold).toHaveBeenCalledOnce();
    expect(m.release).not.toHaveBeenCalled();
  });

  it('refunds the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    await expect(call()).rejects.toMatchObject({ statusCode: 500 });
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });

  it('surfaces a credit refusal as 422 (not 500) and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('logs an empty generated title and reports it as a failed rename', async () => {
    m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
      await cb(['   ']);
    });

    await expect(call()).rejects.toMatchObject({ statusCode: 500, message: 'Failed to auto-rename session' });
    expect(logger.error).toHaveBeenCalledWith('Error in auto-rename:', expect.anything());
  });
});
