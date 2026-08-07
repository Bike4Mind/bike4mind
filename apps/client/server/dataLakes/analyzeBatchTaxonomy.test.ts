import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  setTaxonomyStatusIfActive: vi.fn(),
  fabFindByBatchId: vi.fn(),
  lakeFindById: vi.fn(),
  getEffectiveApiKey: vi.fn(),
  runTaxonomyInference: vi.fn(),
  sendToClient: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeBatchRepository: { setTaxonomyStatusIfActive: h.setTaxonomyStatusIfActive },
  dataLakeRepository: { findById: h.lakeFindById },
  fabFileRepository: { findByBatchId: h.fabFindByBatchId },
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveApiKey: h.getEffectiveApiKey } }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => h.sendToClient(...a) }));
vi.mock('@server/dataLakes/runTaxonomyInference', () => ({
  runTaxonomyInference: h.runTaxonomyInference,
  sampleFabFilesForTaxonomy: (files: unknown[]) => files,
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://example' } } }));

import { analyzeBatchTaxonomy } from './analyzeBatchTaxonomy';

const logger = { error: vi.fn() };

describe('analyzeBatchTaxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] });

    expect(result).toEqual({ claimed: false });
    expect(h.fabFindByBatchId).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('claims with the given from-states and refreshes taxonomyStartedAt', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['ready', 'failed'] });

    expect(h.setTaxonomyStatusIfActive).toHaveBeenNthCalledWith(
      1,
      'b1',
      ['ready', 'failed'],
      'analyzing',
      expect.objectContaining({ taxonomyStartedAt: expect.any(Date) })
    );
  });

  it('fails closed with a real message and notifies when no files exist', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.fabFindByBatchId.mockResolvedValue([]);
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'failed' }); // fail transition

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] });

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

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] });

    expect(h.runTaxonomyInference).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'failed', error: 'No OpenAI API key configured' });
  });

  it('fails closed with a curated message (not the raw error) when inference throws, without touching taxonomySuggestions', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.runTaxonomyInference.mockRejectedValue(new Error('401 Incorrect API key provided: sk-***'));
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'failed' }); // fail transition

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['ready', 'failed'] });

    expect(result).toEqual({
      claimed: true,
      outcome: 'failed',
      error: 'AI tagging service is temporarily unavailable - try re-analyzing',
    });
    // Raw error text never reaches taxonomyError, and - critically - this write has no
    // taxonomySuggestions key at all, so a batch re-analyzed from 'ready' keeps whatever good
    // suggestions it already had instead of losing them to a transient API failure.
    const failCall = h.setTaxonomyStatusIfActive.mock.calls[1];
    expect(failCall[2]).toBe('failed');
    expect(failCall[3]).toEqual({ taxonomyError: 'AI tagging service is temporarily unavailable - try re-analyzing' });
    expect(failCall[3]).not.toHaveProperty('taxonomySuggestions');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('401 Incorrect API key provided'));
  });

  it('does not notify a failure if the fail-transition itself lost a concurrent race', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim wins
    h.fabFindByBatchId.mockResolvedValue([]);
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce(null); // fail-transition loses

    await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] });

    expect(h.sendToClient).not.toHaveBeenCalled();
  });

  it('samples with the lake own fixed prefix, stores sanitized results as ready, and notifies', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1', taxonomyStatus: 'ready' }); // finalize

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, {
      from: ['queued'],
      context: 'legal docs',
    });

    expect(h.runTaxonomyInference).toHaveBeenCalledWith('sk-test', expect.anything(), {
      existingPrefix: 'acme:',
      context: 'legal docs',
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

  // The core race this guards: inference took long enough that the stuck-job reconciler
  // force-failed the batch before the 'ready' transition could land.
  it('discards the computed suggestions and does not notify ready when the ready-transition loses the race', async () => {
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce({ id: 'b1' }); // claim
    h.setTaxonomyStatusIfActive.mockResolvedValueOnce(null); // 'ready' transition loses

    const result = await analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] });

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

    await expect(analyzeBatchTaxonomy('b1', 'lake1', 'u1', logger, { from: ['queued'] })).rejects.toThrow(boom);
    // Only the claim ran - no fail-transition was attempted, since that's the caller's job now.
    expect(h.setTaxonomyStatusIfActive).toHaveBeenCalledTimes(1);
  });
});
