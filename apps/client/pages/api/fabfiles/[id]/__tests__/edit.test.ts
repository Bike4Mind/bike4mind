// @vitest-environment node
/**
 * POST /api/fabfiles/{id}/edit runs an LLM call on the platform's provider keys outside
 * ChatCompletionInvoke, so it must admit the model and reserve credits before the call, then
 * settle or refund. The metering module is faked (balance mechanics: meterPlatformCompletion.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, insufficientCreditsError } from '@bike4mind/common';

const m = vi.hoisted(() => ({
  denied: new Set<string>(),
  reserve: vi.fn(),
  refund: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
    const handlers: Mw[] = [];
    const api = {
      use: (mw: Mw) => (handlers.push(mw), api),
      post: (h: Mw) => async (req: unknown, res: unknown) => {
        for (const mw of [...handlers, h]) {
          let advanced = false;
          await mw(req, res, () => {
            advanced = true;
          });
          if (!advanced) return;
        }
      },
    };
    return api;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@bike4mind/database', () => ({
  FabFile: { findById: m.findById },
  withTransaction: (fn: () => unknown) => fn(),
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: async () => 'https://s/x' }) }));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [{ id: 'model-a', backend: 'anthropic' }],
  getLlmByModel: () => ({ complete: m.complete }),
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModelConfig: async () => null },
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

const { default: handler } = await import('@pages/api/fabfiles/[id]/edit');

const FILE_ID = '65a000000000000000000001';

async function call() {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: FILE_ID },
    body: { instruction: 'Fix the typo', model: 'model-a' },
  });
  Object.assign(req, { user: { id: 'u1' }, ability: { can: () => true }, logger: console });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.denied.clear();
  const file = {
    id: FILE_ID,
    fileName: 'a.txt',
    mimeType: 'text/plain',
    filePath: 'files/u1/a.txt',
    moderationStatus: 'clean',
  };
  m.findById.mockReturnValue({ where: async () => file });
  vi.stubGlobal('fetch', async () => new Response('helo world'));
  m.reserve.mockResolvedValue({ reservedCredits: 10, refund: m.refund });
  // Non-streaming adapters deliver the text, then a final null chunk carrying the usage.
  m.complete.mockImplementation(async (_model, _messages, _opts, cb) => {
    await cb(['hello world']);
    await cb([null], { inputTokens: 200, outputTokens: 10 });
  });
});

describe('POST /api/fabfiles/{id}/edit metering', () => {
  it('refuses a zero-credit caller with 422 and never calls the provider', async () => {
    m.reserve.mockRejectedValue(insufficientCreditsError('You do not have enough credits for AI file editing.'));

    await expect(call()).rejects.toMatchObject({ statusCode: 422 });
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('403s a model the user is not admitted to, before reserving or calling the provider', async () => {
    m.denied.add('model-a');

    await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('settles a funded call on the provider-reported usage', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.reserve).toHaveBeenCalledBefore(m.complete);
    expect(m.settle).toHaveBeenCalledWith({
      model: 'model-a',
      usd: 200 * 0.001 + 10 * 0.002,
      inputTokens: 200,
      outputTokens: 10,
    });
  });

  it('charges the reservation ceiling when the adapter reports no usage', async () => {
    m.complete.mockImplementation(async (_model, _messages, _opts, cb) => cb(['hello world']));

    await call();

    expect(m.settle).toHaveBeenCalledWith(expect.objectContaining({ usd: 1 }));
  });

  it('refunds in full and does not settle when the provider throws or returns nothing', async () => {
    m.complete.mockRejectedValueOnce(new Error('provider down'));
    await expect(call()).rejects.toMatchObject({ statusCode: 400 });

    m.complete.mockImplementationOnce(async (_model, _messages, _opts, cb) => cb(['']));
    await expect(call()).rejects.toThrow('empty response');

    expect(m.refund).toHaveBeenCalledTimes(2);
    expect(m.settle).not.toHaveBeenCalled();
  });
});
