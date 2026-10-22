import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  getAtlasIndexStatus: vi.fn(),
  warmVectorIndex: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminSettingsRepository: { getSettingsValue: async (name: string) => h.settings[name] },
  fabFileChunkRepository: { getAtlasIndexStatus: h.getAtlasIndexStatus, warmVectorIndex: h.warmVectorIndex },
}));

import { runDataLakeVectorIndexKeepWarm } from './dataLakeVectorIndexKeepWarm';

describe('runDataLakeVectorIndexKeepWarm', () => {
  beforeEach(() => {
    h.settings = { EnableDataLakeVectorSearch: true, defaultEmbeddingModel: 'text-embedding-3-small' };
    h.getAtlasIndexStatus.mockResolvedValue({ queryable: true, status: 'READY' });
    h.warmVectorIndex.mockResolvedValue({ hits: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it('queries the default embedding model index when vector search is on', async () => {
    const result = await runDataLakeVectorIndexKeepWarm();

    expect(h.warmVectorIndex).toHaveBeenCalledWith('text-embedding-3-small');
    expect(result).toMatchObject({ status: 'warmed', model: 'text-embedding-3-small', hits: 1 });
  });

  it.each([false, undefined, 'true'])('skips without querying when EnableDataLakeVectorSearch is %s', async flag => {
    h.settings.EnableDataLakeVectorSearch = flag;

    expect(await runDataLakeVectorIndexKeepWarm()).toEqual({ status: 'skipped', reason: 'vector-search-off' });
    expect(h.warmVectorIndex).not.toHaveBeenCalled();
  });

  it.each([undefined, 'not-a-model'])('skips when defaultEmbeddingModel is %s', async model => {
    h.settings.defaultEmbeddingModel = model;

    expect(await runDataLakeVectorIndexKeepWarm()).toEqual({ status: 'skipped', reason: 'embedding-model' });
    expect(h.warmVectorIndex).not.toHaveBeenCalled();
  });

  it.each([null, { queryable: false, status: 'BUILDING' }])('skips when the index status is %o', async status => {
    h.getAtlasIndexStatus.mockResolvedValue(status);

    expect(await runDataLakeVectorIndexKeepWarm()).toEqual({ status: 'skipped', reason: 'not-queryable' });
    expect(h.warmVectorIndex).not.toHaveBeenCalled();
  });

  it('lets a failed query throw so the Lambda run is recorded as an error', async () => {
    h.warmVectorIndex.mockRejectedValue(new Error('mongot unavailable'));

    await expect(runDataLakeVectorIndexKeepWarm()).rejects.toThrow('mongot unavailable');
  });
});
