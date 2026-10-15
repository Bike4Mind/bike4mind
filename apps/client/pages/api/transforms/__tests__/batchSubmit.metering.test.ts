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
  reserve: vi.fn(),
  refund: vi.fn(),
  submitBatch: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: (req: unknown, res: unknown) => unknown) => {
      m.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/config', () => ({ Config: { ANTHROPIC_API_KEY: 'sk-test' } }));
vi.mock('@bike4mind/database', () => ({ transformBatchRepository: { create: m.create } }));
vi.mock('@bike4mind/llm-adapters', () => ({
  getAvailableModels: async () => [{ id: 'claude-opus-4-6' }],
  AnthropicBatchService: { fromApiKey: () => ({ submitBatch: m.submitBatch }) },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createModelAdmission: async () => ({
    assert: async (id: string) => {
      if (m.denied.has(id)) throw new ForbiddenError(`Model "${id}" is not accessible and no fallback available`);
    },
  }),
  completionCeilingUsd: () => 2,
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

beforeEach(() => {
  vi.clearAllMocks();
  m.denied.clear();
  m.enforced = true;
  m.reserve.mockResolvedValue({ hold: m.hold, refund: m.refund });
  m.submitBatch.mockImplementation(async (requests: { clientRef: string }[]) => ({
    anthropicBatchId: 'msgbatch_1',
    customIdMap: requests.map((r, i) => ({ customId: `req_${i}`, clientRef: r.clientRef })),
  }));
});

describe('POST /api/transforms/batch metering', () => {
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
    expect(m.reserve.mock.calls[0][1]).toBe(4);
    expect(m.reserve).toHaveBeenCalledBefore(m.submitBatch);
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        creditHold: m.hold,
        apiKeyId: 'k1',
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

  it('400s a model it cannot price while credits are enforced, and passes it through when they are not', async () => {
    await expect(submit([item('a', 'mystery-model')])).rejects.toMatchObject({ statusCode: 400 });
    expect(m.submitBatch).not.toHaveBeenCalled();

    m.enforced = false;
    expect((await submit([item('a', 'mystery-model')]))._getStatusCode()).toBe(202);
  });
});
