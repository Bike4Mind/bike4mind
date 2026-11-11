import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError, insufficientCreditsError } from '@bike4mind/common';

/**
 * Batch submit runs on the platform Anthropic key, so it must admit every model and reserve the
 * batch's worst-case cost before submitBatch, and persist the hold for the poll to settle.
 */

const m = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
  denied: new Set<string>(),
  enforced: true,
  hold: { ownerId: 'u1', reservedCredits: 40 },
  quotaAdmission: vi.fn(),
  reserve: vi.fn(),
  refund: vi.fn(),
  submitBatch: vi.fn(),
  create: vi.fn(),
  cancel: vi.fn(),
  ceiling: vi.fn(),
  substitute: vi.fn(),
  catalogModels: [] as unknown[],
}));

vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: m.quotaAdmission }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: (req: unknown, res: unknown) => unknown) => {
      m.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));
vi.mock('@bike4mind/database', () => ({ transformBatchRepository: { create: m.create } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => m.catalogModels,
  AnthropicBatchService: { fromApiKey: () => ({ submitBatch: m.submitBatch }) },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { batches: { cancel: m.cancel } };
  },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({
    assert: async (id: string) => {
      if (m.denied.has(id)) throw new ForbiddenError(`Model "${id}" is not accessible and no fallback available`);
    },
  }),
  completionCeilingUsd: (...args: unknown[]) => m.ceiling(...args),
  resolveShadowSubstitute: (...args: unknown[]) => m.substitute(...args),
  isCreditsEnforced: async () => m.enforced,
  reserveCompletionCredits: (...args: unknown[]) => m.reserve(...args),
}));

await import('@pages/api/transforms/batch');

const item = (ref: string, model = 'claude-opus-4-6') => ({
  client_ref: ref,
  model,
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'summarize' }],
});

async function submit(requests: unknown[]) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, {
    user: { id: 'u1' },
    apiKeyInfo: { keyId: 'k1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    body: { requests },
  });
  await m.postHandler!(req, res);
  return res;
}

const opus = {
  id: 'claude-opus-4-6',
  backend: 'anthropic',
  type: 'text',
  pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
};
const sonnet = { ...opus, id: 'claude-sonnet-4-6' };
const haiku = { ...opus, id: 'claude-haiku-4-5', pricing: { 200_000: { input: 1e-7, output: 2e-7 } } };

beforeEach(() => {
  vi.clearAllMocks();
  m.catalogModels = [opus];
  m.substitute.mockResolvedValue(undefined);
  m.quotaAdmission.mockResolvedValue({ release: vi.fn() });
  m.denied.clear();
  m.enforced = true;
  m.ceiling.mockReturnValue(2);
  m.cancel.mockResolvedValue({});
  m.reserve.mockResolvedValue({ hold: m.hold, refund: m.refund });
  m.submitBatch.mockImplementation(async (requests: { clientRef: string }[]) => ({
    anthropicBatchId: 'msgbatch_1',
    customIdMap: requests.map((r, i) => ({ customId: `req_${i}`, clientRef: r.clientRef })),
  }));
});

describe('POST /api/transforms/batch metering', () => {
  it('refuses quota exhaustion before reserving credits or submitting provider work', async () => {
    m.quotaAdmission.mockRejectedValueOnce(Object.assign(new Error('token quota'), { statusCode: 429 }));
    await expect(submit([item('a')])).rejects.toMatchObject({ statusCode: 429 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.submitBatch).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('checks only the token quota for queued provider work', async () => {
    await submit([item('a')]);
    expect(m.quotaAdmission).toHaveBeenCalledWith(expect.objectContaining({ apiKeyInfo: { keyId: 'k1' } }), {
      holdSlot: false,
    });
    expect(m.quotaAdmission).toHaveBeenCalledBefore(m.reserve);
  });

  it('refuses a zero-credit key with 422 and never submits', async () => {
    m.reserve.mockRejectedValue(insufficientCreditsError('You do not have enough credits for batch transforms.'));

    await expect(submit([item('a')])).rejects.toMatchObject({ statusCode: 422 });
    expect(m.submitBatch).not.toHaveBeenCalled();
  });

  it('403s a model the caller is not admitted to, before reserving or submitting', async () => {
    m.denied.add('claude-opus-4-6');

    await expect(submit([item('a')])).rejects.toMatchObject({ statusCode: 403 });
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.submitBatch).not.toHaveBeenCalled();
  });

  it('reserves the summed per-item ceiling and persists the hold for the poll', async () => {
    const res = await submit([item('a'), item('b')]);

    expect(res._getStatusCode()).toBe(202);
    expect(m.reserve.mock.calls[0][1]).toBe(2);
    // Outlives Anthropic's 29-day results window, so the sweep cannot refund a batch a late poll can still bill.
    expect(m.reserve.mock.calls[0][3]).toEqual({ holdTtlMs: 29 * 24 * 60 * 60_000 });
    expect(m.reserve).toHaveBeenCalledBefore(m.submitBatch);
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        creditHold: m.hold,
        billingModels: {
          'claude-opus-4-6': expect.objectContaining({
            id: 'claude-opus-4-6',
            pricing: { 200_000: { input: 1e-6, output: 2e-6 } },
          }),
        },
        apiKeyId: 'k1',
        usageSource: 'api',
        customIdMap: [
          { customId: 'req_0', clientRef: 'a', model: 'claude-opus-4-6' },
          { customId: 'req_1', clientRef: 'b', model: 'claude-opus-4-6' },
        ],
      })
    );
  });

  it('refunds and persists nothing when the submit fails', async () => {
    m.submitBatch.mockRejectedValue(new Error('anthropic down'));

    await expect(submit([item('a')])).rejects.toThrow('anthropic down');
    expect(m.refund).toHaveBeenCalledTimes(1);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('accepts duplicate client_refs and persists each under its own customId', async () => {
    const res = await submit([item('a'), item('a')]);

    expect(res._getStatusCode()).toBe(202);
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customIdMap: [
          { customId: 'req_0', clientRef: 'a', model: 'claude-opus-4-6' },
          { customId: 'req_1', clientRef: 'a', model: 'claude-opus-4-6' },
        ],
      })
    );
  });

  it('cancels the batch then refunds the hold when persisting fails after a successful submit', async () => {
    m.create.mockRejectedValueOnce(new Error('db down'));
    const order: string[] = [];
    m.cancel.mockImplementation(async () => void order.push('cancel'));
    m.refund.mockImplementation(async () => void order.push('refund'));

    await expect(submit([item('a')])).rejects.toThrow('db down');
    expect(m.submitBatch).toHaveBeenCalledTimes(1);
    expect(m.cancel).toHaveBeenCalledWith('msgbatch_1');
    expect(order).toEqual(['cancel', 'refund']);
  });

  it('still refunds and rethrows the persist error when the cancel fails', async () => {
    m.create.mockRejectedValueOnce(new Error('db down'));
    m.cancel.mockRejectedValueOnce(new Error('cancel down'));

    await expect(submit([item('a')])).rejects.toThrow('db down');
    expect(m.refund).toHaveBeenCalledTimes(1);
  });

  it('prices the ceiling at the cache-write rate only for a request with a cache breakpoint', async () => {
    const cached = {
      ...item('b'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'p', cache_control: { type: 'ephemeral' } }] }],
    };
    await submit([item('a'), cached]);

    expect(m.ceiling.mock.calls.map(c => c[3])).toEqual([false, true]);
  });

  it('reserves one-hour cache writes at twice the input rate, with the batch discount', async () => {
    await submit([
      {
        ...item('a'),
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'p', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
    ]);

    expect(m.ceiling.mock.calls[0][0].pricing[200_000].cache_write).toBe(2e-6);
    expect(m.ceiling.mock.calls[0][3]).toBe(true);
    expect(m.reserve.mock.calls[0][1]).toBe(1);
  });

  it('400s a model it cannot price while credits are enforced, and passes it through when they are not', async () => {
    await expect(submit([item('a', 'mystery-model')])).rejects.toMatchObject({ statusCode: 400 });
    expect(m.submitBatch).not.toHaveBeenCalled();

    m.enforced = false;
    expect((await submit([item('a', 'mystery-model')]))._getStatusCode()).toBe(202);
  });

  describe('restricted-tier substitution', () => {
    it('runs the substitute while the hold and credit model stay on the requested model', async () => {
      m.catalogModels = [opus, haiku];
      m.substitute.mockResolvedValue(haiku);

      await submit([item('a'), item('b')]);

      expect(m.submitBatch.mock.calls[0][0].map((r: { model: string }) => r.model)).toEqual([
        'claude-haiku-4-5',
        'claude-haiku-4-5',
      ]);
      expect(m.ceiling.mock.calls.every(c => c[0].id === 'claude-opus-4-6')).toBe(true);
      expect(m.reserve.mock.calls[0][1]).toBe(2);
      const created = m.create.mock.calls[0][0];
      expect(created.customIdMap).toEqual([
        { customId: 'req_0', clientRef: 'a', model: 'claude-opus-4-6', executedModel: 'claude-haiku-4-5' },
        { customId: 'req_1', clientRef: 'b', model: 'claude-opus-4-6', executedModel: 'claude-haiku-4-5' },
      ]);
      expect(Object.keys(created.billingModels).sort()).toEqual(['claude-haiku-4-5', 'claude-opus-4-6']);
    });

    it('refunds and masks the provider error when a substituted batch fails to submit', async () => {
      m.catalogModels = [opus, haiku];
      m.substitute.mockResolvedValue(haiku);
      m.submitBatch.mockRejectedValue(new Error('model claude-haiku-4-5 overloaded'));

      await expect(submit([item('a')])).rejects.toThrow(/^Batch submission failed$/);
      expect(m.refund).toHaveBeenCalledTimes(1);
      expect(m.create).not.toHaveBeenCalled();
    });

    it('offers only Anthropic models as substitute candidates', async () => {
      m.catalogModels = [opus, haiku, { ...opus, id: 'gpt-x', backend: 'openai' }];

      await submit([item('a')]);

      const candidates = m.substitute.mock.calls[0][2] as { backend: string }[];
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every(c => c.backend === 'anthropic')).toBe(true);
    });

    it('sends the requested model and records no executedModel when nothing is substituted', async () => {
      m.catalogModels = [opus, haiku];

      await submit([item('a')]);

      expect(m.submitBatch.mock.calls[0][0][0].model).toBe('claude-opus-4-6');
      const created = m.create.mock.calls[0][0];
      expect(created.customIdMap[0]).not.toHaveProperty('executedModel');
      expect(Object.keys(created.billingModels)).toEqual(['claude-opus-4-6']);
    });

    it('clamps max_tokens to the substitute declared output limit without changing the hold', async () => {
      m.catalogModels = [opus, haiku];
      m.substitute.mockResolvedValue({ ...haiku, max_tokens: 400 });

      await submit([item('a')]);

      expect(m.submitBatch.mock.calls[0][0][0].maxTokens).toBe(400);
      expect(m.ceiling.mock.calls.every(c => c[0].id === 'claude-opus-4-6' && c[2] === 1000)).toBe(true);
      expect(m.reserve.mock.calls[0][1]).toBe(1);
    });

    it('leaves max_tokens alone when the substitute limit is derived or higher', async () => {
      m.catalogModels = [opus, haiku];
      m.substitute.mockResolvedValue({ ...haiku, max_tokens: 400, maxOutputTokensDerived: true });
      await submit([item('a')]);
      expect(m.submitBatch.mock.calls[0][0][0].maxTokens).toBe(1000);

      m.substitute.mockResolvedValue({ ...haiku, max_tokens: 8000 });
      await submit([item('a')]);
      expect(m.submitBatch.mock.calls[1][0][0].maxTokens).toBe(1000);
    });

    it('sends the requested max_tokens unchanged when nothing is substituted', async () => {
      m.catalogModels = [opus, haiku];

      await submit([item('a')]);

      expect(m.submitBatch.mock.calls[0][0][0].maxTokens).toBe(1000);
    });

    it('rewrites only the requests of the substituted model in a mixed batch', async () => {
      m.catalogModels = [opus, sonnet, haiku];
      m.substitute.mockImplementation(async (_req: unknown, info: { id: string }) =>
        info.id === 'claude-opus-4-6' ? haiku : undefined
      );

      await submit([item('a'), item('b', 'claude-sonnet-4-6'), item('c')]);

      expect(m.substitute).toHaveBeenCalledTimes(2);
      expect(m.submitBatch.mock.calls[0][0].map((r: { model: string }) => r.model)).toEqual([
        'claude-haiku-4-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5',
      ]);
      const map = m.create.mock.calls[0][0].customIdMap;
      expect(map[0].executedModel).toBe('claude-haiku-4-5');
      expect(map[1]).not.toHaveProperty('executedModel');
      expect(map[1].model).toBe('claude-sonnet-4-6');
    });
  });
});
