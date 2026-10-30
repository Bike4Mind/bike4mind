import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  models: [] as string[],
  getAtlasIndexStatus: vi.fn(),
  warmVectorIndex: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/fab-pipeline', () => ({ atlasVectorIndexModels: () => h.models }));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminSettingsRepository: { getSettingsValue: async (name: string) => h.settings[name] },
  fabFileChunkRepository: { getAtlasIndexStatus: h.getAtlasIndexStatus, warmVectorIndex: h.warmVectorIndex },
}));

import { runDataLakeVectorIndexKeepWarm } from './dataLakeVectorIndexKeepWarm';

describe('runDataLakeVectorIndexKeepWarm', () => {
  beforeEach(() => {
    h.settings = { EnableDataLakeVectorSearch: true };
    h.models = ['text-embedding-3-small', 'text-embedding-ada-002'];
    h.getAtlasIndexStatus.mockResolvedValue({ queryable: true, status: 'READY' });
    h.warmVectorIndex.mockResolvedValue({ hits: 1 });
  });
  afterEach(() => vi.clearAllMocks());

  it('warms every queryable index, not only the default model', async () => {
    const result = await runDataLakeVectorIndexKeepWarm();

    expect(h.warmVectorIndex.mock.calls.map(c => c[0])).toEqual(['text-embedding-3-small', 'text-embedding-ada-002']);
    expect(result).toEqual({
      status: 'ran',
      warmed: [
        { model: 'text-embedding-3-small', hits: 1, durationMs: expect.any(Number) },
        { model: 'text-embedding-ada-002', hits: 1, durationMs: expect.any(Number) },
      ],
    });
  });

  it.each([false, undefined, 'true'])('skips without querying when EnableDataLakeVectorSearch is %s', async flag => {
    h.settings.EnableDataLakeVectorSearch = flag;

    expect(await runDataLakeVectorIndexKeepWarm()).toEqual({ status: 'skipped', reason: 'vector-search-off' });
    expect(h.getAtlasIndexStatus).not.toHaveBeenCalled();
    expect(h.warmVectorIndex).not.toHaveBeenCalled();
  });

  it.each([null, { queryable: false, status: 'BUILDING' }])('skips an index whose status is %o', async status => {
    h.getAtlasIndexStatus.mockImplementation(async (model: string) =>
      model === 'text-embedding-ada-002' ? status : { queryable: true, status: 'READY' }
    );

    const result = await runDataLakeVectorIndexKeepWarm();

    expect(h.warmVectorIndex.mock.calls.map(c => c[0])).toEqual(['text-embedding-3-small']);
    expect(result).toMatchObject({ status: 'ran', warmed: [{ model: 'text-embedding-3-small' }] });
  });

  it('still warms the remaining indexes when one fails, then throws so the run is recorded as an error', async () => {
    h.warmVectorIndex.mockImplementation(async (model: string) => {
      if (model === 'text-embedding-3-small') throw new Error('mongot unavailable');
      return { hits: 1 };
    });

    await expect(runDataLakeVectorIndexKeepWarm()).rejects.toThrow('1 index(es) failed to warm');
    expect(h.warmVectorIndex).toHaveBeenCalledWith('text-embedding-ada-002');
  });
});
