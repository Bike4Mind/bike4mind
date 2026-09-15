import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDataLakeResearchConfigDocument } from '@bike4mind/common';
import {
  RESEARCH_CONFIG_NAME_MAX_CHARS,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
} from '@bike4mind/common';
import {
  createResearchConfig,
  deleteResearchConfig,
  listResearchConfigs,
  updateResearchConfig,
  RESEARCH_CONFIGS_PER_LAKE_MAX,
  type ResearchConfigAdapters,
} from './researchConfigs';

const LAKE = 'lake-1';
const ACTOR = 'user-1';

const storedConfig = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
  ({
    id: 'config-1',
    dataLakeId: LAKE,
    name: 'Weekly sweep',
    trigger: 'on_demand',
    createdByUserId: ACTOR,
    query: 'coastal erosion',
    model: 'gpt-4.1-mini',
    maxResults: 10,
    maxProposals: 5,
    recencyDays: 30,
    allowedDomains: ['example.com'],
    blockedDomains: [],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: ['research'],
    ...overrides,
  }) as IDataLakeResearchConfigDocument;

const makeAdapters = (overrides: Partial<ResearchConfigAdapters['db']['dataLakeResearchConfigs']> = {}) => {
  const repo = {
    createConfig: vi.fn(async (input: unknown) => ({ id: 'new', ...(input as object) })),
    listByLake: vi.fn(async () => [] as IDataLakeResearchConfigDocument[]),
    findByIdInLake: vi.fn(async () => storedConfig()),
    updateConfig: vi.fn(async (_id: string, _lake: string, patch: unknown) => ({
      ...storedConfig(),
      ...(patch as object),
    })),
    deleteConfig: vi.fn(async () => true),
    ...overrides,
  };
  return { adapters: { db: { dataLakeResearchConfigs: repo } } as unknown as ResearchConfigAdapters, repo };
};

describe('createResearchConfig', () => {
  it('stores normalized levers, not the raw input', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(LAKE, ACTOR, { name: '  Weekly  ', query: '  erosion  ', maxResults: 9_999 }, adapters);

    expect(repo.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: LAKE,
        name: 'Weekly',
        createdByUserId: ACTOR,
        query: 'erosion',
        maxResults: 50,
        minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
      })
    );
  });

  it('truncates an overlong name', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(LAKE, ACTOR, { name: 'n'.repeat(500), query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].name).toHaveLength(RESEARCH_CONFIG_NAME_MAX_CHARS);
  });

  it('refuses a blank name', async () => {
    const { adapters } = makeAdapters();
    await expect(createResearchConfig(LAKE, ACTOR, { name: '  ', query: 'q' }, adapters)).rejects.toThrow(
      /needs a name/
    );
  });

  // v1 is user-triggered. Storing a trigger nothing will ever fire is a setting that silently does
  // nothing, which is worse than a refusal.
  it('accepts on_demand and refuses the triggers v1 cannot fire', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'on_demand' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('on_demand');

    await expect(
      createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'scheduled' }, adapters)
    ).rejects.toThrow(/not available yet/);
    await expect(
      createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'periodic' }, adapters)
    ).rejects.toThrow(/not available yet/);
  });

  it('defaults an absent trigger to on_demand', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('on_demand');
  });

  it('caps how many configurations one lake may hold', async () => {
    const full = Array.from({ length: RESEARCH_CONFIGS_PER_LAKE_MAX }, (_v, i) => storedConfig({ id: `c${i}` }));
    const { adapters } = makeAdapters({ listByLake: vi.fn(async () => full) });

    await expect(createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q' }, adapters)).rejects.toThrow(/maximum/);
  });
});

describe('listResearchConfigs', () => {
  it('scopes the read to the lake', async () => {
    const { adapters, repo } = makeAdapters();
    await listResearchConfigs(LAKE, adapters);
    expect(repo.listByLake).toHaveBeenCalledWith(LAKE);
  });
});

describe('updateResearchConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes over the merge of stored and incoming, so a patch keeps the untouched levers', async () => {
    const { adapters, repo } = makeAdapters();

    // No query in the patch. Normalizing the patch alone would refuse it as an empty query.
    await updateResearchConfig('config-1', LAKE, 'user-2', { maxProposals: 3 }, adapters);

    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE,
      expect.objectContaining({
        query: 'coastal erosion',
        maxProposals: 3,
        maxResults: 10,
        lastUpdatedByUserId: 'user-2',
      })
    );
  });

  // The clearing case: normalizeResearchLevers OMITS an unset recencyDays/model, and a $set of a
  // partial would leave the previous value in place - the user would watch the field come back.
  it('writes an explicit null when recencyDays or model is cleared', async () => {
    const { adapters, repo } = makeAdapters();

    await updateResearchConfig('config-1', LAKE, ACTOR, { recencyDays: null, model: null }, adapters);

    const patch = repo.updateConfig.mock.calls[0][2];
    expect(patch.recencyDays).toBeNull();
    expect(patch.model).toBeNull();
  });

  it('re-clamps a stored value that is now out of range', async () => {
    const { adapters, repo } = makeAdapters({
      findByIdInLake: vi.fn(async () => storedConfig({ maxResults: 9_999 })),
    });

    await updateResearchConfig('config-1', LAKE, ACTOR, { name: 'renamed' }, adapters);

    expect(repo.updateConfig.mock.calls[0][2].maxResults).toBe(50);
  });

  it('leaves the name alone when the patch omits it', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig('config-1', LAKE, ACTOR, { maxResults: RESEARCH_MAX_RESULTS_DEFAULT }, adapters);
    expect(repo.updateConfig.mock.calls[0][2]).not.toHaveProperty('name');
  });

  it('404s on a config that is not in this lake', async () => {
    const { adapters } = makeAdapters({ findByIdInLake: vi.fn(async () => null) });
    await expect(updateResearchConfig('config-1', LAKE, ACTOR, {}, adapters)).rejects.toThrow(/not found/);
  });

  it('404s when the write itself matches nothing', async () => {
    const { adapters } = makeAdapters({ updateConfig: vi.fn(async () => null) });
    await expect(updateResearchConfig('config-1', LAKE, ACTOR, {}, adapters)).rejects.toThrow(/not found/);
  });
});

describe('deleteResearchConfig', () => {
  it('scopes the delete to the lake', async () => {
    const { adapters, repo } = makeAdapters();
    await deleteResearchConfig('config-1', LAKE, adapters);
    expect(repo.deleteConfig).toHaveBeenCalledWith('config-1', LAKE);
  });

  it('404s when nothing was deleted', async () => {
    const { adapters } = makeAdapters({ deleteConfig: vi.fn(async () => false) });
    await expect(deleteResearchConfig('config-1', LAKE, adapters)).rejects.toThrow(/not found/);
  });
});
