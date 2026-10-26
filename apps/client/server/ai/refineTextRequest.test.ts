import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetCachedData,
  mockGetOperationsModel,
  mockRefineText,
  mockCreateRequestCompletionMeter,
  mockMeter,
  mockSettle,
  mockRefund,
} = vi.hoisted(() => ({
  mockGetCachedData: vi.fn(),
  mockGetOperationsModel: vi.fn(),
  mockRefineText: vi.fn(),
  mockCreateRequestCompletionMeter: vi.fn(),
  mockMeter: vi.fn(),
  mockSettle: vi.fn(),
  mockRefund: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ cacheRepository: {} }));
vi.mock('@bike4mind/services', async () => ({
  cacheService: { getCachedData: mockGetCachedData },
  // The real wrapper, so reserve -> provider call -> settle/refund runs as it ships.
  meterCompletionBackend: (
    await vi.importActual<typeof import('@bike4mind/services/billing/completionMeter')>(
      '@bike4mind/services/billing/completionMeter'
    )
  ).meterCompletionBackend,
}));
vi.mock('@bike4mind/services/llm/refineText', () => ({ refineText: mockRefineText }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: mockGetOperationsModel },
  OperationsModelUnavailableError: class OperationsModelUnavailableError extends Error {},
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createRequestCompletionMeter: mockCreateRequestCompletionMeter,
}));

import { insufficientCreditsError } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { RefineFailedError, refineTextRequest } from './refineTextRequest';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const MODEL_INFO = { id: 'ops-model', backend: 'openai', max_tokens: 4096 };

// MeteredRequest is an Express request shape; the helper only reads user, logger and apiKeyInfo.
const request = (user: Record<string, unknown> = { id: 'user-1', isModerated: false }) =>
  ({ user, logger, headers: {}, apiKeyInfo: { keyId: 'key-1' } }) as never;

const providerCompleting = (text: string) =>
  vi.fn(async (_model: string, _messages: unknown, _opts: unknown, callback: (...a: unknown[]) => Promise<void>) => {
    await callback([text], { inputTokens: 12, outputTokens: 7 });
  });

describe('refineTextRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedData.mockImplementation(async (_key: string, producer: () => Promise<string>) => producer());
    mockRefineText.mockImplementation(
      async (_params: unknown, { llm }: { llm: { complete: (...a: unknown[]) => Promise<void> } }) => {
        let out = '';
        await llm.complete([{ role: 'user', content: 'x' }], async (chunk: string) => {
          out += chunk ?? '';
        });
        return out;
      }
    );
    mockCreateRequestCompletionMeter.mockReturnValue(mockMeter);
    mockMeter.mockResolvedValue({ settle: mockSettle, refund: mockRefund });
    mockSettle.mockResolvedValue(1);
    mockRefund.mockResolvedValue(undefined);
  });

  it('refuses a moderated user before the cache, so a cached refinement is not served either', async () => {
    await expect(refineTextRequest({ text: 'hello' }, request({ isModerated: true }))).rejects.toBeInstanceOf(
      ForbiddenError
    );
    expect(mockGetCachedData).not.toHaveBeenCalled();
    expect(mockGetOperationsModel).not.toHaveBeenCalled();
  });

  it('charges the caller for a cache miss: reserve before the provider call, settle its usage after', async () => {
    const complete = providerCompleting('refined');
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', modelInfo: MODEL_INFO, llm: { complete } });
    const req = request();

    await expect(refineTextRequest({ text: 'hello' }, req)).resolves.toBe('refined');

    expect(mockCreateRequestCompletionMeter).toHaveBeenCalledWith(req, 'text refinement', { systemModel: true });
    expect(mockMeter).toHaveBeenCalledTimes(1);
    expect(mockMeter.mock.calls[0][0]).toBe(MODEL_INFO);
    expect(mockMeter.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]);
    expect(mockSettle).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 12, outputTokens: 7 }));
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it('serves a cache hit without reserving or charging anything', async () => {
    mockGetCachedData.mockResolvedValue('cached');

    await expect(refineTextRequest({ text: 'hello' }, request())).resolves.toBe('cached');

    expect(mockMeter).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('surfaces a billing refusal as itself (422), never calling the provider or wrapping it as a provider failure', async () => {
    const complete = providerCompleting('refined');
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', modelInfo: MODEL_INFO, llm: { complete } });
    const refusal = insufficientCreditsError('Insufficient credits for text refinement');
    mockMeter.mockRejectedValue(refusal);

    await expect(refineTextRequest({ text: 'hello' }, request())).rejects.toBe(refusal);

    expect(complete).not.toHaveBeenCalled();
  });

  it('refunds the hold when the provider fails before reporting usage', async () => {
    const providerError = new Error('upstream down');
    const complete = vi.fn().mockRejectedValue(providerError);
    mockGetOperationsModel.mockResolvedValue({ modelId: 'ops-model', modelInfo: MODEL_INFO, llm: { complete } });

    const error = await refineTextRequest({ text: 'hello' }, request()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RefineFailedError);
    expect((error as RefineFailedError).cause).toBe(providerError);
    expect(mockRefund).toHaveBeenCalledTimes(1);
    expect(mockSettle).not.toHaveBeenCalled();
  });
});
