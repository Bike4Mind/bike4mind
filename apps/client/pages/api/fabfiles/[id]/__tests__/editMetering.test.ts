// @vitest-environment node
/**
 * POST /api/fabfiles/{id}/edit runs an LLM call on the platform's provider keys outside
 * ChatCompletionInvoke, so it must admit the model and reserve credits before the call, then
 * settle or refund. The metering module is faked (balance mechanics: meterPlatformCompletion.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ChatModels, ForbiddenError, insufficientCreditsError } from '@bike4mind/common';

vi.mock('@server/utils/untrustedCompletionQuota', () => ({
  admitRequestCompletion: vi.fn().mockResolvedValue({ release: async () => undefined }),
}));

const m = vi.hoisted(() => ({
  denied: new Set<string>(),
  admissionFlags: [] as unknown[],
  reserve: vi.fn(),
  refund: vi.fn(),
  settle: vi.fn(),
  complete: vi.fn(),
  findById: vi.fn(),
  assertRewriteFits: vi.fn(),
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
  fabFileRepository: {},
  organizationRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getSignedUrl: async () => 'https://s/x' }),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({}) },
  fabFilesService: { assertRewriteFits: m.assertRewriteFits },
}));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [
    { id: 'model-a', backend: 'anthropic' },
    { id: ChatModels.CLAUDE_4_6_SONNET_BEDROCK, backend: 'anthropic' },
  ],
  getLlmByModel: () => ({ complete: m.complete }),
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModelConfig: async () => null },
}));
vi.mock('@server/billing/meterPlatformCompletion', async () => ({
  ...(await import('@bike4mind/services/billing/completionMeter')),
  createModelAdmission: async (_user: unknown, _models: unknown, systemModel?: boolean) => {
    m.admissionFlags.push(systemModel);
    return {
      admits: async (id: string) => !m.denied.has(id),
      assert: async (id: string) => {
        if (m.denied.has(id)) throw new ForbiddenError(`Model "${id}" is not accessible and no fallback available`);
      },
    };
  },
  completionRequestCeilingUsd: () => 1,
  reserveCompletionCredits: (...args: unknown[]) => m.reserve(...args),
  completionUsd: (
    _model: unknown,
    u: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
  ) =>
    (u.inputTokens ?? 0) * 0.001 +
    (u.outputTokens ?? 0) * 0.002 +
    (u.cacheReadInputTokens ?? 0) * 0.0001 +
    (u.cacheCreationInputTokens ?? 0) * 0.00125,
  settleCompletion: (_reservation: unknown, _req: unknown, charge: unknown) => m.settle(charge),
}));

const { default: handler } = await import('@pages/api/fabfiles/[id]/edit');

const FILE_ID = '65a000000000000000000001';

async function call(applyImmediately = false, model?: string) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: FILE_ID },
    body: { instruction: 'Fix the typo', model: arguments.length > 1 ? model : 'model-a', applyImmediately },
  });
  Object.assign(req, { user: { id: 'u1' }, ability: { can: () => true }, logger: console });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stubbed router's param type is loose
  await (handler as any)(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.denied.clear();
  m.admissionFlags.length = 0;
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
  it.each(['cacheReadInputTokens', 'cacheCreationInputTokens'] as const)(
    'prices cache-only %s usage on a successful response',
    async field => {
      m.complete.mockImplementation(async (_model, _messages, _options, callback) => {
        await callback(['answer'], { inputTokens: 0, outputTokens: 0, [field]: 100 });
      });

      await call();

      const usd = 100 * (field === 'cacheReadInputTokens' ? 0.0001 : 0.00125);
      expect(m.settle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ usd: expect.closeTo(usd, 12), [field]: 100 })
      );
      expect(m.refund).not.toHaveBeenCalled();
    }
  );

  it.each(['cacheReadInputTokens', 'cacheCreationInputTokens'] as const)(
    'settles cache-only %s usage when the provider later throws',
    async field => {
      m.complete.mockImplementation(async (_model, _messages, _options, callback) => {
        await callback(['partial'], { inputTokens: 0, outputTokens: 0, [field]: 100 });
        throw new Error('stream disconnected');
      });

      await expect(call()).rejects.toThrow('stream disconnected');

      const usd = 100 * (field === 'cacheReadInputTokens' ? 0.0001 : 0.00125);
      expect(m.settle).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ usd: expect.closeTo(usd, 12), [field]: 100 })
      );
      expect(m.refund).not.toHaveBeenCalled();
    }
  );

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

  it('admits a request-supplied model as a user choice and a platform-picked fallback as a system model', async () => {
    await call();
    await call(false, undefined);

    expect(m.admissionFlags).toEqual([false, true]);
  });

  it('settles a funded call on the provider-reported usage', async () => {
    const res = await call();

    expect(res._getStatusCode()).toBe(200);
    expect(m.reserve).toHaveBeenCalledBefore(m.complete);
    expect(m.settle).toHaveBeenCalledWith({
      model: 'model-a',
      provider: 'anthropic',
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

  it('refunds in full and does not settle when the provider throws', async () => {
    m.complete.mockRejectedValueOnce(new Error('provider down'));
    await expect(call()).rejects.toMatchObject({ statusCode: 400 });

    expect(m.refund).toHaveBeenCalledOnce();
    expect(m.settle).not.toHaveBeenCalled();
  });

  it('settles the reported usage, without refunding, when the model returns nothing', async () => {
    m.complete.mockImplementationOnce(async (_model, _messages, _opts, cb) => {
      await cb(['']);
      await cb([null], { inputTokens: 200, outputTokens: 0 });
    });

    await expect(call()).rejects.toThrow('empty response');
    expect(m.settle).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ usd: 200 * 0.001, inputTokens: 200 }));
    expect(m.refund).not.toHaveBeenCalled();
  });

  it('refuses an applied edit whose worst-case size cannot fit, before reserving or calling the provider', async () => {
    m.assertRewriteFits.mockRejectedValue(
      Object.assign(new Error('File size exceeds storage limit'), { statusCode: 400 })
    );

    await expect(call(true)).rejects.toThrow('storage limit');
    expect(m.assertRewriteFits).toHaveBeenCalledWith(
      expect.objectContaining({ id: FILE_ID }),
      4000 * 4,
      expect.anything(),
      expect.objectContaining({ id: 'u1' })
    );
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.complete).not.toHaveBeenCalled();
  });

  it('does not run the storage pre-check when the edit is not applied', async () => {
    await call(false);

    expect(m.assertRewriteFits).not.toHaveBeenCalled();
  });
});
