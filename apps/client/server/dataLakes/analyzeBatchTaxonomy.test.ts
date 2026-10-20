import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ForbiddenError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  setTaxonomyStatusIfActive: vi.fn(),
  fabFindByBatchId: vi.fn(),
  lakeFindById: vi.fn(),
  getEffectiveApiKey: vi.fn(),
  runTaxonomyInference: vi.fn(),
  sendToClient: vi.fn(),
  meter: vi.fn(),
  requestMeter: vi.fn(),
  createRequestCompletionMeter: vi.fn(),
  batchFindById: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive, findById: h.batchFindById },
  dataLakeRepository: { findById: h.lakeFindById },
  fabFileRepository: { findByBatchId: h.fabFindByBatchId },
  apiKeyRepository: {},
  adminSettingsRepository: {},
  userRepository: { findById: async (id: string) => ({ id }) },
}));
vi.mock('@bike4mind/llm-adapters', () => ({ getAvailableModels: async () => [{ id: 'gpt-4o-mini' }] }));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createCompletionMeter: () => h.meter,
  createRequestCompletionMeter: (...a: unknown[]) => h.createRequestCompletionMeter(...a),
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveApiKey: h.getEffectiveApiKey } }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => h.sendToClient(...a) }));
vi.mock('@bike4mind/server-utils/dataLakes/runTaxonomyInference', () => ({
  runTaxonomyInference: h.runTaxonomyInference,
  sampleFabFilesForTaxonomy: (files: unknown[]) => files,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://example' } } }));

import { analyzeBatchTaxonomy, claimBatchForAnalysis } from './analyzeBatchTaxonomy';

const logger = { error: vi.fn(), warn: vi.fn() };

describe('analyzeBatchTaxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.batchFindById.mockResolvedValue({ id: 'b1' });
    h.sendToClient.mockResolvedValue(undefined);
    h.fabFindByBatchId.mockResolvedValue([{ relativePath: 'legal/a.pdf', fileName: 'a.pdf', fileSize: 10 }]);
    h.lakeFindById.mockResolvedValue({ id: 'lake1', fileTagPrefix: 'acme:' });
    h.getEffectiveApiKey.mockResolvedValue('sk-test');
    h.runTaxonomyInference.mockResolvedValue({
      suggestedPrefix: 'acme:',
      suggestedName: '',
      categories: [{ tagName: 'acme:type:contract', confidence: 0.9, matchingFolders: ['legal'] }],
      fileAssignments: [],
    });
  });

  it('returns claimed: false without touching anything else when the guarded claim loses', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue(null);

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(result).toEqual({ claimed: false });
    expect(h.fabFindByBatchId).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('claims with the given from-states and refreshes taxonomyStartedAt', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['ready', 'failed'] });

    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['ready', 'failed'],
      'analyzing',
      expect.objectContaining({ taxonomyStartedAt: expect.any(Date) })
    );
  });

  it('skips the claim when the caller already holds it and finalizes straight to ready', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { claimHeldByCaller: true });

    expect(h.setTaxonomyStatusIfActive).not.toHaveBeenCalledWith(
      'b1',
      expect.anything(),
      'analyzing',
      expect.anything()
    );
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledTimes(1);
    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['analyzing'],
      'ready',
      expect.objectContaining({ taxonomySuggestions: expect.anything() })
    );
    expect(result.outcome).toBe('ready');
  });

  it('claimBatchForAnalysis passes the from-set and a fresh taxonomyStartedAt', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' });

    const claimed = await claimBatchForAnalysis('b1', ['ready', 'failed']);

    expect(claimed).toEqual({ id: 'b1' });
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledWith('b1', ['ready', 'failed'], 'analyzing', {
      taxonomyStartedAt: expect.any(Date),
    });
  });

  it('fails closed with a real message and notifies when no files exist', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.fabFindByBatchId.mockResolvedValue([]);
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'failed' }); // fail transition

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(result).toEqual({ claimed: true, outcome: 'failed', error: 'No files found for this batch' });
    expect(h.setTaxonomyStatusIfActive).toHaveBeenLastCalledWith('b1', ['analyzing'], 'failed', {
      taxonomyError: 'No files found for this batch',
    });
    expect(h.sendToClient).toHaveBeenCalledWith(
      'u1',
      'wss://example',
      expect.objectContaining({ taxonomyStatus: 'failed' })
    );
  });

  it('fails closed when no OpenAI key is configured, without calling inference', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' });
    h.getEffectiveApiKey.mockResolvedValue(null);
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'failed' });

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(h.runTaxonomyInference).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'failed', error: 'No OpenAI API key configured' });
  });

  it('propagates a genuine inference API failure as an unexpected exception, without touching taxonomySuggestions itself', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    const apiError = new Error('401 Incorrect API key provided: sk-***');
    h.runTaxonomyInference.mockRejectedValue(apiError);

    await expect(
      analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['ready', 'failed'] })
    ).rejects.toThrow(apiError);
    // Left to the caller (queue handler releases the claim for SQS retry; the manual endpoint
    // marks it failed itself) - this function itself never writes taxonomySuggestions here, so
    // neither caller's own handling can clobber a prior-good suggestion set either.
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledTimes(1);
  });

  it('does not notify a failure if the fail-transition itself lost a concurrent race', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim wins
    h.fabFindByBatchId.mockResolvedValue([]);
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce(null); // fail-transition loses

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('samples with the lake own fixed prefix, stores sanitized results as ready, and notifies', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, {
      from: ['queued'],
      context: 'legal docs',
    });

    expect(h.runTaxonomyInference).toHaveBeenCalledWith('sk-test', expect.anything(), {
      existingPrefix: 'acme:',
      context: 'legal docs',
      reserve: expect.any(Function),
    });
    expect(h.setTaxonomyStatusIfActive).toHaveBeenLastCalledWith(
      'b1',
      ['analyzing'],
      'ready',
      expect.objectContaining({
        taxonomySuggestions: expect.objectContaining({
          tags: expect.arrayContaining([expect.objectContaining({ originalName: 'acme:type:contract' })]),
        }),
      })
    );
    expect(result).toEqual({ claimed: true, outcome: 'ready', batch: { id: 'b1', taxonomyStatus: 'ready' } });
    expect(h.sendToClient).toHaveBeenCalledWith(
      'u1',
      'wss://example',
      expect.objectContaining({ taxonomyStatus: 'ready' })
    );
  });

  it('warns when the model returns more categories than sanitizeCategories will keep', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize
    h.runTaxonomyInference.mockResolvedValue({
      suggestedPrefix: 'acme:',
      suggestedName: '',
      categories: Array.from({ length: 150 }, (_, i) => ({ tagName: `acme:type:cat${i}` })),
      fileAssignments: [],
    });

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('150 categories - capped to 100'));
  });

  it('does not warn when the model stays within the category cap', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The core race this guards: inference took long enough that the stuck-job reconciler
  // force-failed the batch before the 'ready' transition could land.
  it('discards the computed suggestions and does not notify ready when the ready-transition loses the race', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce(null); // 'ready' transition loses

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });

    expect(result).toEqual({
      claimed: true,
      outcome: 'failed',
      error: 'Batch status changed before analysis could complete',
    });
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('propagates an unexpected exception rather than swallowing it into a generic failure', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    const boom = new Error('DB connection reset');
    h.fabFindByBatchId.mockRejectedValue(boom);

    await expect(analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] })).rejects.toThrow(
      boom
    );
    // Only the claim ran - no fail-transition was attempted, since that's the caller's job now.
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledTimes(1);
  });

  it('bills the inference to the batch user through the reserve hook', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { claimHeldByCaller: true });

    const { reserve } = h.runTaxonomyInference.mock.calls[0][2];
    await reserve([{ role: 'user', content: 'x' }], 4000);
    expect(h.meter).toHaveBeenCalledWith({ id: 'gpt-4o-mini' }, [{ role: 'user', content: 'x' }], 4000, [
      { id: 'gpt-4o-mini' },
    ]);
  });

  it('fails the batch without rethrowing when the user is out of credits', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
    h.runTaxonomyInference.mockRejectedValue({
      statusCode: 422,
      additionalInfo: { errorCode: 'insufficient_credits' },
    });

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { claimHeldByCaller: true });

    expect(result).toMatchObject({
      claimed: true,
      outcome: 'failed',
      error: 'Not enough credits to analyze this batch',
    });
  });

  it("meters a re-analyze through the caller's request, so an API key bills its billing owner", async () => {
    h.createRequestCompletionMeter.mockReturnValue(h.requestMeter);
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1', taxonomyStatus: 'ready' });
    const req = { user: { id: 'u1' }, apiKeyInfo: { keyId: 'k1' } };

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { claimHeldByCaller: true, req: req as never });
    await h.runTaxonomyInference.mock.calls[0][2].reserve([], 10);

    expect(h.createRequestCompletionMeter).toHaveBeenCalledWith(req, 'data lake taxonomy', { systemModel: true });
    expect(h.requestMeter).toHaveBeenCalled();
    expect(h.meter).not.toHaveBeenCalled();
  });

  it.each(['orgB', null])(
    'keeps the upload payer %s for queued analysis rather than the current seat',
    async organizationId => {
      h.batchFindById.mockResolvedValue({
        id: 'b1',
        taxonomyBilling: { organizationId, apiKeyId: 'key1', source: 'cli' },
      });
      h.createRequestCompletionMeter.mockReturnValue(h.requestMeter);
      h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });

      await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] });
      await h.runTaxonomyInference.mock.calls[0][2].reserve([], 10);

      expect(h.createRequestCompletionMeter).toHaveBeenCalledWith(
        expect.objectContaining({
          user: { id: 'u1' },
          usageSource: 'cli',
          apiKeyInfo: {
            keyId: 'key1',
            billingOwnerType: organizationId ? 'Organization' : 'User',
            organizationId: organizationId ?? undefined,
          },
        }),
        'data lake taxonomy',
        { systemModel: true, organizationId }
      );
      expect(h.requestMeter).toHaveBeenCalled();
      expect(h.meter).not.toHaveBeenCalled();
    }
  );

  it('uses the current re-analyze requester instead of the upload snapshot', async () => {
    h.batchFindById.mockResolvedValue({ taxonomyBilling: { organizationId: 'oldOrg' } });
    h.createRequestCompletionMeter.mockReturnValue(h.requestMeter);
    h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
    const req = { user: { id: 'u2' }, headers: {} };

    await analyzeBatchTaxonomy('b1', 'lake1', 'u2', logger as never, { claimHeldByCaller: true, req: req as never });

    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.createRequestCompletionMeter).toHaveBeenCalledWith(req, 'data lake taxonomy', { systemModel: true });
  });

  it.each([new BadRequestError('Key holder left the org'), new ForbiddenError('Model is unavailable')])(
    'records a permanent billing refusal as failed instead of retrying it: %s',
    async error => {
      h.setTaxonomyStatusIfActive.mockResolvedValue({ id: 'b1' });
      h.runTaxonomyInference.mockRejectedValue(error);

      await expect(
        analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger as never, { from: ['queued'] })
      ).resolves.toMatchObject({ outcome: 'failed', error: error.message });
      expect(h.setTaxonomyStatusIfActive).toHaveBeenLastCalledWith('b1', ['analyzing'], 'failed', {
        taxonomyError: error.message,
      });
    }
  );
});
