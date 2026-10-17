/**
 * Lattice chat runs on the platform's provider keys outside ChatCompletionInvoke, so it must admit
 * the model and reserve credits before the provider call, then settle or refund. The metering
 * module is faked here (its balance mechanics are covered in meterPlatformCompletion.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ChatModels, ForbiddenError, insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  denied: new Set<string>(),
  reserve: vi.fn(),
  refund: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
  models: [] as { id: string; supportsTools: boolean }[],
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({ apiKeyRepository: {}, adminSettingsRepository: {} }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => m.models,
  getLlmByModel: () => ({ complete: m.complete }),
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({
    admits: async (id: string) => !m.denied.has(id),
    assert: async (id: string) => {
      if (m.denied.has(id)) throw new ForbiddenError(`Model "${id}" is not accessible and no fallback available`);
    },
  }),
  completionCeilingUsd: () => 1,
  reserveCompletionCredits: (...args: unknown[]) => m.reserve(...args),
  latchUsage: (u: Record<string, number>, info?: Record<string, number>) => {
    if (info?.inputTokens) u.inputTokens = info.inputTokens;
    if (info?.outputTokens) u.outputTokens = info.outputTokens;
  },
  completionUsd: (_model: unknown, u: { inputTokens?: number; outputTokens?: number }) =>
    (u.inputTokens ?? 0) * 0.001 + (u.outputTokens ?? 0) * 0.002,
  settleCompletion: (_reservation: unknown, _req: unknown, charge: unknown) => m.settle(charge),
}));

const { default: handler } = await import('@pages/api/lattice/chat');

async function call() {
  const { req, res } = createMocks({ method: 'POST', body: { message: 'Build a P&L' } });
  Object.assign(req, { user: { id: 'u1' } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.denied.clear();
  m.models = [
    { id: ChatModels.CLAUDE_4_6_SONNET, supportsTools: true, backend: 'anthropic' },
    { id: ChatModels.CLAUDE_4_5_SONNET, supportsTools: true },
  ];
  m.reserve.mockResolvedValue({ reservedCredits: 10, refund: m.refund });
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['hello'], { inputTokens: 100, outputTokens: 50 });
  });
});

describe('POST /api/lattice/chat metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.reserve.mockRejectedValue(insufficientCreditsError('You do not have enough credits for Lattice chat.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('settles a funded call on the provider-reported usage', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.reserve).toHaveBeenCalledBefore(m.complete);
    expect(m.settle).toHaveBeenCalledWith({
      model: ChatModels.CLAUDE_4_6_SONNET,
      provider: 'anthropic',
      usd: 100 * 0.001 + 50 * 0.002,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(m.refund).not.toHaveBeenCalled();
  });

  it('settles at the reservation ceiling when the adapter reports no usage', async () => {
    m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
      await cb(['hello'], {});
    });

    await call();

    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ usd: 1, inputTokens: 0, outputTokens: 0 }));
  });

  it('refunds in full and does not settle when the provider throws', async () => {
    m.complete.mockRejectedValue(new Error('provider down'));

    await expect(call()).rejects.toThrow('provider down');
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('skips a preferred model the user is not admitted to', async () => {
    m.denied.add(ChatModels.CLAUDE_4_6_SONNET);

    await call();

    expect(m.complete.mock.calls[0][0]).toBe(ChatModels.CLAUDE_4_5_SONNET);
  });

  it('403s before any reservation or provider call when no tool model is admitted', async () => {
    m.models.forEach(model => m.denied.add(model.id));

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });
});
