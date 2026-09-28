import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDataLakeResearchConfigDocument } from '@bike4mind/common';
import {
  RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_MAX,
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
const NOW = new Date('2026-03-01T12:00:00.000Z');

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
  return {
    adapters: { db: { dataLakeResearchConfigs: repo }, now: () => NOW } as unknown as ResearchConfigAdapters,
    repo,
  };
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

  it('defaults to an unscheduled on-demand config with the default review limit', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0]).toMatchObject({
      trigger: 'on_demand',
      cadence: 'off',
      nextRunAt: null,
      scheduleAnchorAt: null,
      reviewBacklogLimit: RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT,
    });
  });

  it('schedules the first run one period out and derives the periodic trigger', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', cadence: 'weekly' }, adapters);
    expect(repo.createConfig.mock.calls[0][0]).toMatchObject({
      trigger: 'periodic',
      cadence: 'weekly',
      nextRunAt: new Date('2026-03-08T12:00:00.000Z'),
      scheduleAnchorAt: new Date('2026-03-08T12:00:00.000Z'),
    });
  });

  it('clamps the review limit', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', reviewBacklogLimit: 0 }, adapters);
    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', reviewBacklogLimit: 1e9 }, adapters);
    expect(repo.createConfig.mock.calls[0][0].reviewBacklogLimit).toBe(1);
    expect(repo.createConfig.mock.calls[1][0].reviewBacklogLimit).toBe(RESEARCH_REVIEW_BACKLOG_LIMIT_MAX);
  });

  // A trigger that disagrees with the cadence would save a setting that silently does nothing.
  it('accepts a trigger only when it agrees with the cadence', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'periodic', cadence: 'daily' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('periodic');

    await expect(
      createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'periodic' }, adapters)
    ).rejects.toThrow(/needs a cadence/);
    await expect(
      createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'on_demand', cadence: 'daily' }, adapters)
    ).rejects.toThrow(/cannot have a cadence/);
    await expect(
      createResearchConfig(LAKE, ACTOR, { name: 'n', query: 'q', trigger: 'scheduled', cadence: 'daily' }, adapters)
    ).rejects.toThrow(/One-off scheduled/);
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

  it('resets the next run when the cadence changes', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig('config-1', LAKE, ACTOR, { cadence: 'daily' }, adapters);
    expect(repo.updateConfig.mock.calls[0][2]).toMatchObject({
      cadence: 'daily',
      trigger: 'periodic',
      nextRunAt: new Date('2026-03-02T12:00:00.000Z'),
      scheduleAnchorAt: new Date('2026-03-02T12:00:00.000Z'),
      lastScheduledOutcome: null,
    });
  });

  it('clears the next run when scheduling is switched off', async () => {
    const { adapters, repo } = makeAdapters({
      findByIdInLake: vi.fn(async () =>
        storedConfig({ cadence: 'daily', trigger: 'periodic', nextRunAt: new Date('2026-03-01T20:00:00.000Z') })
      ),
    });
    await updateResearchConfig('config-1', LAKE, ACTOR, { cadence: 'off' }, adapters);
    expect(repo.updateConfig.mock.calls[0][2]).toMatchObject({
      cadence: 'off',
      trigger: 'on_demand',
      nextRunAt: null,
      scheduleAnchorAt: null,
    });
  });

  // Editing the query of a daily config must not push today's run a whole day out.
  it('keeps the next run when the cadence is unchanged', async () => {
    const { adapters, repo } = makeAdapters({
      findByIdInLake: vi.fn(async () =>
        storedConfig({ cadence: 'daily', trigger: 'periodic', nextRunAt: new Date('2026-03-01T20:00:00.000Z') })
      ),
    });
    await updateResearchConfig('config-1', LAKE, ACTOR, { cadence: 'daily', query: 'new question' }, adapters);
    const patch = repo.updateConfig.mock.calls[0][2];
    expect(patch).not.toHaveProperty('nextRunAt');
    expect(patch).not.toHaveProperty('scheduleAnchorAt');
    expect(patch).not.toHaveProperty('cadence');
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
