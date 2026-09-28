import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDataLakeDocument, IDataLakeResearchConfigDocument } from '@bike4mind/common';
import {
  RESEARCH_CONFIG_NAME_MAX_CHARS,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
} from '@bike4mind/common';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  createResearchConfig,
  deleteResearchConfig,
  listResearchConfigs,
  updateResearchConfig,
  RESEARCH_CONFIGS_PER_LAKE_MAX,
  type ResearchConfigAdapters,
} from './researchConfigs';

const LAKE_ID = 'lake-1';
const ACTOR_ID = 'user-1';
/** No caller wires a grant repo of its own anymore - the route's gate loads grants once and
 * passes them straight in, so every test here supplies them the same way. */
const NO_GRANTS: LakeGrant[] = [];

const lake = (overrides: Partial<IDataLakeDocument> = {}) =>
  ({ id: LAKE_ID, createdByUserId: ACTOR_ID, ...overrides }) as IDataLakeDocument;

const actor = (userId: string = ACTOR_ID): ManageActor => ({ userId, isAdmin: false, administeredOrgIds: [] });

const storedConfig = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
  ({
    id: 'config-1',
    dataLakeId: LAKE_ID,
    name: 'Weekly sweep',
    trigger: 'on_demand',
    createdByUserId: ACTOR_ID,
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
  const record = vi.fn(async () => undefined);
  return {
    adapters: {
      db: { dataLakeResearchConfigs: repo, lakeConfigChangeEvents: { record } },
    } as unknown as ResearchConfigAdapters,
    repo,
    record,
  };
};

describe('createResearchConfig', () => {
  it('stores normalized levers, not the raw input', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: '  Weekly  ', query: '  erosion  ', maxResults: 9_999 },
      adapters
    );

    expect(repo.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: LAKE_ID,
        name: 'Weekly',
        createdByUserId: ACTOR_ID,
        query: 'erosion',
        maxResults: 50,
        minRelevance: RESEARCH_MIN_RELEVANCE_DEFAULT,
      })
    );
  });

  it('truncates an overlong name', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n'.repeat(500), query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].name).toHaveLength(RESEARCH_CONFIG_NAME_MAX_CHARS);
  });

  it('refuses a blank name', async () => {
    const { adapters } = makeAdapters();
    await expect(
      createResearchConfig(lake(), actor(), NO_GRANTS, { name: '  ', query: 'q' }, adapters)
    ).rejects.toThrow(/needs a name/);
  });

  // v1 is user-triggered. Storing a trigger nothing will ever fire is a setting that silently does
  // nothing, which is worse than a refusal.
  it('accepts on_demand and refuses the triggers v1 cannot fire', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', trigger: 'on_demand' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('on_demand');

    await expect(
      createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', trigger: 'scheduled' }, adapters)
    ).rejects.toThrow(/not available yet/);
    await expect(
      createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', trigger: 'periodic' }, adapters)
    ).rejects.toThrow(/not available yet/);
  });

  it('defaults an absent trigger to on_demand', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('on_demand');
  });

  it('caps how many configurations one lake may hold', async () => {
    const full = Array.from({ length: RESEARCH_CONFIGS_PER_LAKE_MAX }, (_v, i) => storedConfig({ id: `c${i}` }));
    const { adapters } = makeAdapters({ listByLake: vi.fn(async () => full) });

    await expect(createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters)).rejects.toThrow(
      /maximum/
    );
  });

  // #3298: creating a research config left no trace in the lake's History tab.
  it('records a create-research-config history event naming the config', async () => {
    const { adapters, record } = makeAdapters();

    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'Weekly sweep', query: 'q' }, adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: ACTOR_ID,
        dataLakeId: LAKE_ID,
        action: 'create-research-config',
        changes: [{ field: 'researchConfig', kind: 'literal', after: 'created: Weekly sweep' }],
      })
    );
  });

  // #3298 follow-up: a curator's write used to record as `system` because nothing passed the
  // gate's own grants through - pinned here so a regression back to an internal re-fetch (which
  // silently returns [] without a wired grant repo) fails loudly.
  it('records the manage rung the passed-in grants actually authorize, not `system`', async () => {
    const { adapters, record } = makeAdapters();
    const curatorGrants: LakeGrant[] = [{ principalType: 'user', principalId: 'curator-1', role: 'curator' }];

    await createResearchConfig(lake(), actor('curator-1'), curatorGrants, { name: 'n', query: 'q' }, adapters);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ manageRung: 'grant-curator' }));
  });
});

describe('listResearchConfigs', () => {
  it('scopes the read to the lake', async () => {
    const { adapters, repo } = makeAdapters();
    await listResearchConfigs(LAKE_ID, adapters);
    expect(repo.listByLake).toHaveBeenCalledWith(LAKE_ID);
  });
});

describe('updateResearchConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('normalizes over the merge of stored and incoming, so a patch keeps the untouched levers', async () => {
    const { adapters, repo } = makeAdapters();

    // No query in the patch. Normalizing the patch alone would refuse it as an empty query.
    await updateResearchConfig('config-1', lake(), actor('user-2'), NO_GRANTS, { maxProposals: 3 }, adapters);

    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
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

    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { recencyDays: null, model: null }, adapters);

    const patch = repo.updateConfig.mock.calls[0][2];
    expect(patch.recencyDays).toBeNull();
    expect(patch.model).toBeNull();
  });

  it('re-clamps a stored value that is now out of range', async () => {
    const { adapters, repo } = makeAdapters({
      findByIdInLake: vi.fn(async () => storedConfig({ maxResults: 9_999 })),
    });

    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { name: 'renamed' }, adapters);

    expect(repo.updateConfig.mock.calls[0][2].maxResults).toBe(50);
  });

  it('leaves the name alone when the patch omits it', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      { maxResults: RESEARCH_MAX_RESULTS_DEFAULT },
      adapters
    );
    expect(repo.updateConfig.mock.calls[0][2]).not.toHaveProperty('name');
  });

  it('404s on a config that is not in this lake', async () => {
    const { adapters } = makeAdapters({ findByIdInLake: vi.fn(async () => null) });
    await expect(updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, {}, adapters)).rejects.toThrow(
      /not found/
    );
  });

  it('404s when the write itself matches nothing', async () => {
    const { adapters } = makeAdapters({ updateConfig: vi.fn(async () => null) });
    await expect(updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, {}, adapters)).rejects.toThrow(
      /not found/
    );
  });

  it('records an update-research-config history event naming the current (post-update) name', async () => {
    const { adapters, record } = makeAdapters();

    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { name: 'Renamed sweep' }, adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update-research-config',
        changes: [{ field: 'researchConfig', kind: 'literal', after: 'updated: Renamed sweep' }],
      })
    );
  });
});

describe('deleteResearchConfig', () => {
  it('scopes the delete to the lake', async () => {
    const { adapters, repo } = makeAdapters();
    await deleteResearchConfig('config-1', lake(), actor(), NO_GRANTS, adapters);
    expect(repo.deleteConfig).toHaveBeenCalledWith('config-1', LAKE_ID);
  });

  it('404s when nothing was deleted', async () => {
    const { adapters } = makeAdapters({ deleteConfig: vi.fn(async () => false) });
    await expect(deleteResearchConfig('config-1', lake(), actor(), NO_GRANTS, adapters)).rejects.toThrow(/not found/);
  });

  it('404s on a config that is not in this lake, before ever calling delete', async () => {
    const { adapters, repo } = makeAdapters({ findByIdInLake: vi.fn(async () => null) });
    await expect(deleteResearchConfig('config-1', lake(), actor(), NO_GRANTS, adapters)).rejects.toThrow(/not found/);
    expect(repo.deleteConfig).not.toHaveBeenCalled();
  });

  it('records a delete-research-config history event naming the config that was removed', async () => {
    const { adapters, record } = makeAdapters();

    await deleteResearchConfig('config-1', lake(), actor(), NO_GRANTS, adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete-research-config',
        changes: [{ field: 'researchConfig', kind: 'literal', after: 'deleted: Weekly sweep' }],
      })
    );
  });
});
