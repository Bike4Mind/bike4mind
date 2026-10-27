// @vitest-environment node
/**
 * POST /api/agents/create-from-context runs the generation model on the platform key, so it must
 * hold credits before the provider call and settle the reported usage after (or refund on a throw).
 * The real meterPlatformCompletion + reserveRequestCredits run; only the credit store is faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestError, ForbiddenError, insufficientCreditsError } from '@bike4mind/common';

const quotaAdmission = vi.hoisted(() => vi.fn().mockResolvedValue({ release: async () => {} }));
vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: quotaAdmission }));

const m = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  enforce: true,
  hold: vi.fn(),
  release: vi.fn(),
  settleHold: vi.fn(),
  record: vi.fn(async () => undefined),
  complete: vi.fn(),
  agentCreate: vi.fn(),
  admissionAssert: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      m.handler = fn;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', async () => ({
  ...(await import('@server/__tests__/pendingCreditHoldFake')).pendingCreditHoldFake,
  sessionRepository: { findById: vi.fn().mockResolvedValue({ id: 'sess-1', userId: 'user-1', knowledgeIds: [] }) },
  questRepository: { findAllBySessionId: vi.fn().mockResolvedValue([{ prompt: 'hello', fabFileIds: [] }]) },
  agentOpsSettingsRepository: { getSettings: vi.fn().mockResolvedValue(null) },
  fabFileRepository: { findAccessibleInIds: vi.fn().mockResolvedValue([]) },
  agentRepository: { countByUserId: vi.fn().mockResolvedValue(0), create: m.agentCreate },
  projectRepository: { create: vi.fn().mockResolvedValue({ id: 'proj-1' }) },
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
  createModelAdmission: () => ({ admits: async () => true, assert: m.admissionAssert }),
}));
vi.mock('@bike4mind/services/cliCompletions', () => ({ estimateInputTokens: () => 1000 }));
vi.mock('@server/entitlements', () => ({ getUserEntitlements: vi.fn() }));
vi.mock('@server/dataLakes/attachmentLakeAccess', () => ({ createAttachmentLakeAccess: () => async () => ({}) }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: vi.fn() }));

const MODEL = { id: 'gpt-4-test', backend: 'openai', pricing: { 200_000: { input: 1e-6, output: 2e-6 } } };
// Partial: the metered backend sizes its hold with the real llm-adapters output-budget helpers.
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: async () => [MODEL],
  getLlmByModel: () => ({ complete: m.complete }),
}));

await import('../create-from-context');

const PROFILE = JSON.stringify({ description: 'A helper', systemPrompt: 'You are Helper.' });

async function call() {
  const req = {
    body: { agentName: 'Helper', sessionId: '67dbe18a7f9cf1fa5d9686aa' },
    user: { id: 'user-1', level: 'Free', groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
  };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  await m.handler!(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.enforce = true;
  m.admissionAssert.mockResolvedValue(undefined);
  m.hold.mockResolvedValue({ ownerId: 'user-1', ownerType: 'user', reservedCredits: 50 });
  m.settleHold.mockImplementation(async (_hold, credits: number) => credits);
  m.agentCreate.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'agent-1', ...data }));
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb([PROFILE]);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/agents/create-from-context metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.hold.mockRejectedValue(insufficientCreditsError('You do not have enough credits.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
    expect(m.agentCreate).not.toHaveBeenCalled();
  });

  it('keeps the 403 when the model is not admitted, without reserving or calling the provider', async () => {
    m.admissionAssert.mockRejectedValue(new ForbiddenError('Model "gpt-4-test" is not accessible'));

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('keeps the 400 when the model is unavailable, without reserving or calling the provider', async () => {
    m.admissionAssert.mockRejectedValue(new BadRequestError('Model "gpt-4-test" is currently unavailable'));

    await expect(call()).rejects.toMatchObject({ statusCode: 400 });
    expect(m.hold).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('charges a funded caller the priced usage once', async () => {
    await call();

    expect(m.hold).toHaveBeenCalledBefore(m.complete);
    expect(m.record).toHaveBeenCalledOnce();
    expect(m.record).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4-test',
        provider: 'openai',
        costUsd: expect.closeTo(200 * 1e-6 + 10 * 2e-6, 12),
      })
    );
    expect(m.settleHold).toHaveBeenCalledOnce();
  });

  it('refunds the hold when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    const res = await call();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(m.release).toHaveBeenCalledOnce();
    expect(m.settleHold).not.toHaveBeenCalled();
  });
});

it('enforces the API completion quota before invoking the model', async () => {
  const refusal = new Error('completion quota exhausted');
  quotaAdmission.mockRejectedValueOnce(refusal);
  await expect(call()).rejects.toBe(refusal);
  expect(quotaAdmission).toHaveBeenCalledWith(expect.objectContaining({ user: expect.any(Object) }), {
    holdSlot: true,
  });
  expect(m.complete).not.toHaveBeenCalled();
});
