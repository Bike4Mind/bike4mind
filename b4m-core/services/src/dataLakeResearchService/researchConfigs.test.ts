import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IDataLakeDocument, IDataLakeResearchConfigDocument, ResearchKeysetPage } from '@bike4mind/common';
import {
  RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
  RESEARCH_MAX_AUTO_ADMITS_LIMIT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_DEFAULT,
  RESEARCH_REVIEW_BACKLOG_LIMIT_MAX,
  RESEARCH_CONFIG_NAME_MAX_CHARS,
  RESEARCH_FEED_URL_MAX_CHARS,
  RESEARCH_MAX_RESULTS_DEFAULT,
  RESEARCH_MIN_RELEVANCE_DEFAULT,
} from '@bike4mind/common';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  createResearchConfig,
  deleteResearchConfig,
  listResearchConfigs,
  setResearchSchedulePaused,
  updateResearchConfig,
  RESEARCH_CONFIGS_PER_LAKE_MAX,
  type ResearchConfigAdapters,
} from './researchConfigs';

const LAKE_ID = 'lake-1';
const ACTOR_ID = 'user-1';
const NOW = new Date('2026-03-01T12:00:00.000Z');
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
    trustedDomains: [],
    reviewDomains: ['example.com'],
    unlistedSources: 'drop',
    autoAdmitTrusted: false,
    maxAutoAdmits: RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
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
  const record = vi.fn(async (_input: unknown) => ({ id: 'evt-1' }));
  const snapshotRecord = vi.fn(async (_input: unknown) => undefined);
  return {
    snapshotRecord,
    adapters: {
      db: {
        dataLakeResearchConfigs: repo,
        lakeConfigChangeEvents: { record },
        lakeConfigSnapshots: { record: snapshotRecord },
      },
      now: () => NOW,
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

  it('defaults to an unscheduled on-demand config with the default review limit', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters);
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
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', cadence: 'weekly' }, adapters);
    expect(repo.createConfig.mock.calls[0][0]).toMatchObject({
      trigger: 'periodic',
      cadence: 'weekly',
      nextRunAt: new Date('2026-03-08T12:00:00.000Z'),
      scheduleAnchorAt: new Date('2026-03-08T12:00:00.000Z'),
    });
  });

  it('clamps the review limit', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', reviewBacklogLimit: 0 }, adapters);
    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', reviewBacklogLimit: 1e9 },
      adapters
    );
    expect(repo.createConfig.mock.calls[0][0].reviewBacklogLimit).toBe(1);
    expect(repo.createConfig.mock.calls[1][0].reviewBacklogLimit).toBe(RESEARCH_REVIEW_BACKLOG_LIMIT_MAX);
  });

  // A trigger that disagrees with the cadence would save a setting that silently does nothing.
  it('accepts a trigger only when it agrees with the cadence', async () => {
    const { adapters, repo } = makeAdapters();

    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', trigger: 'periodic', cadence: 'daily' },
      adapters
    );
    expect(repo.createConfig.mock.calls[0][0].trigger).toBe('periodic');

    await expect(
      createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', trigger: 'periodic' }, adapters)
    ).rejects.toThrow(/needs a cadence/);
    await expect(
      createResearchConfig(
        lake(),
        actor(),
        NO_GRANTS,
        { name: 'n', query: 'q', trigger: 'on_demand', cadence: 'daily' },
        adapters
      )
    ).rejects.toThrow(/cannot have a cadence/);
    await expect(
      createResearchConfig(
        lake(),
        actor(),
        NO_GRANTS,
        { name: 'n', query: 'q', trigger: 'scheduled', cadence: 'daily' },
        adapters
      )
    ).rejects.toThrow(/One-off scheduled/);
  });

  it('caps how many configurations one lake may hold', async () => {
    const full = Array.from({ length: RESEARCH_CONFIGS_PER_LAKE_MAX }, (_v, i) => storedConfig({ id: `c${i}` }));
    const { adapters } = makeAdapters({ listByLake: vi.fn(async () => full) });

    await expect(createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters)).rejects.toThrow(
      /maximum/
    );
  });

  // Creating a research config left no trace in the lake's History tab.
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

  // Follow-up: a curator's write used to record as `system` because nothing passed the
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
    expect(repo.listByLake).toHaveBeenCalledWith(LAKE_ID, undefined);
  });

  it('forwards a keyset page to the read', async () => {
    const { adapters, repo } = makeAdapters();
    const page: ResearchKeysetPage = { limit: 5, after: { createdAt: new Date('2026-01-01'), id: 'cfg-1' } };
    await listResearchConfigs(LAKE_ID, adapters, page);
    expect(repo.listByLake).toHaveBeenCalledWith(LAKE_ID, page);
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

  it('resets the next run when the cadence changes', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'daily' }, adapters);
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
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'off' }, adapters);
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
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      { cadence: 'daily', query: 'new question' },
      adapters
    );
    const patch = repo.updateConfig.mock.calls[0][2];
    expect(patch).not.toHaveProperty('nextRunAt');
    expect(patch).not.toHaveProperty('scheduleAnchorAt');
    expect(patch).not.toHaveProperty('cadence');
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
        target: { kind: 'researchConfig', id: 'config-1' },
        changes: [
          { field: 'researchConfig', kind: 'literal', after: 'updated: Renamed sweep' },
          { field: 'researchConfig', kind: 'literal', after: 'name Weekly sweep -> Renamed sweep: Renamed sweep' },
        ],
        leverChanges: [{ lever: 'name', before: 'Weekly sweep', after: 'Renamed sweep' }],
      })
    );
  });

  // A resubmit that changes nothing is not an event a History reader needs to see - and without
  // this guard it wrote one anyway, indistinguishable from a real edit.
  it('does not record a history event when the submitted body matches what is already stored', async () => {
    const { adapters, record } = makeAdapters();

    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      {
        name: 'Weekly sweep',
        query: 'coastal erosion',
        model: 'gpt-4.1-mini',
        maxResults: 10,
        maxProposals: 5,
        recencyDays: 30,
        reviewDomains: ['example.com'],
        unlistedSources: 'drop',
        blockedDomains: [],
        minRelevance: 0.6,
        costCeilingMicroUsd: 50_000,
        proposedTags: ['research'],
      },
      adapters
    );

    expect(record).not.toHaveBeenCalled();
  });

  // Round-2 finding: comparing via JSON.stringify of two object literals broke exactly this case -
  // `normalizeResearchLevers` omits `model`/`recencyDays` from its return object entirely when
  // they're unset rather than inserting them in their "natural" position, so the two sides'
  // stringified key order differed even though every value matched, and a byte-identical resubmit
  // of the DEFAULT config still recorded a history event.
  it('does not record a history event on an idempotent resubmit of the default config (no model, no recencyDays)', async () => {
    const defaultStored = storedConfig({ model: undefined, recencyDays: undefined });
    const { adapters, record } = makeAdapters({ findByIdInLake: vi.fn(async () => defaultStored) });

    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      {
        name: defaultStored.name,
        query: defaultStored.query,
        maxResults: defaultStored.maxResults,
        maxProposals: defaultStored.maxProposals,
        reviewDomains: defaultStored.reviewDomains,
        unlistedSources: defaultStored.unlistedSources,
        blockedDomains: defaultStored.blockedDomains,
        minRelevance: defaultStored.minRelevance,
        costCeilingMicroUsd: defaultStored.costCeilingMicroUsd,
        proposedTags: defaultStored.proposedTags,
      },
      adapters
    );

    expect(record).not.toHaveBeenCalled();
  });

  it('does not record a history event when reviewDomains, blockedDomains and proposedTags are resubmitted reordered', async () => {
    const stored = storedConfig({
      reviewDomains: ['a.example.com', 'b.example.com'],
      allowedDomains: ['a.example.com', 'b.example.com'],
      blockedDomains: ['x.example.com', 'y.example.com'],
      proposedTags: ['one', 'two'],
    });
    const { adapters, record } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });

    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      {
        name: stored.name,
        query: stored.query,
        maxResults: stored.maxResults,
        maxProposals: stored.maxProposals,
        reviewDomains: ['b.example.com', 'a.example.com'],
        unlistedSources: 'drop',
        blockedDomains: ['y.example.com', 'x.example.com'],
        minRelevance: stored.minRelevance,
        costCeilingMicroUsd: stored.costCeilingMicroUsd,
        proposedTags: ['two', 'one'],
      },
      adapters
    );

    expect(record).not.toHaveBeenCalled();
  });
});

describe('updateResearchConfig - a real lever change still records history', () => {
  const put = async (patch: Record<string, unknown>) => {
    const stored = storedConfig();
    const { adapters, record } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      {
        name: stored.name,
        query: stored.query,
        maxResults: stored.maxResults,
        maxProposals: stored.maxProposals,
        reviewDomains: stored.reviewDomains,
        unlistedSources: stored.unlistedSources,
        blockedDomains: stored.blockedDomains,
        minRelevance: stored.minRelevance,
        costCeilingMicroUsd: stored.costCeilingMicroUsd,
        proposedTags: stored.proposedTags,
        ...patch,
      },
      adapters
    );
    return record;
  };

  it.each([
    ['an added review domain', { reviewDomains: ['example.com', 'other.example.org'] }],
    ['a changed unlisted-sources setting', { unlistedSources: 'review' }],
    ['an added blocked domain', { blockedDomains: ['spam.example.net'] }],
    ['a replaced proposed tag', { proposedTags: ['different'] }],
  ])('records for %s', async (_label, patch) => {
    expect(await put(patch)).toHaveBeenCalled();
  });
});

describe('research config source tiers', () => {
  const reviewModeStored = () =>
    storedConfig({ reviewDomains: ['kept.example'], unlistedSources: 'review', allowedDomains: [] });

  it('derives allowedDomains on create for old readers', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', reviewDomains: ['a.example'], unlistedSources: 'drop' },
      adapters
    );
    expect(repo.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewDomains: ['a.example'],
        unlistedSources: 'drop',
        trustedDomains: [],
        allowedDomains: ['a.example'],
      })
    );
  });

  it('maps a legacy-shaped create (an old tab) so the restriction is kept', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', allowedDomains: ['a.example'] },
      adapters
    );
    expect(repo.createConfig).toHaveBeenCalledWith(
      expect.objectContaining({ reviewDomains: ['a.example'], unlistedSources: 'drop' })
    );
  });

  it('refuses a drop with nothing listed on create and update', async () => {
    const { adapters } = makeAdapters();
    await expect(
      createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', unlistedSources: 'drop' }, adapters)
    ).rejects.toThrow(/at least one site/i);
    await expect(
      updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { reviewDomains: [] }, adapters)
    ).rejects.toThrow(/at least one site/i);
  });

  it('applies a new-shape edit over the stale derived allowedDomains', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { reviewDomains: ['other.example'] }, adapters);
    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
      expect.objectContaining({
        reviewDomains: ['other.example'],
        unlistedSources: 'drop',
        allowedDomains: ['other.example'],
      })
    );
  });

  it('keeps the review list on an old-tab query-only edit of a review-mode config', async () => {
    const stored = reviewModeStored();
    const { adapters, repo, record } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      { query: 'a new question', allowedDomains: [] },
      adapters
    );
    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
      expect.objectContaining({ reviewDomains: ['kept.example'], unlistedSources: 'review', allowedDomains: [] })
    );
    expect(record).toHaveBeenCalled();
  });

  it('records no history event when an old tab resubmits what the config already derives', async () => {
    const stored = storedConfig();
    const { adapters, record } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      { name: stored.name, query: stored.query, allowedDomains: ['example.com'] },
      adapters
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('maps an old-tab edit of the site list onto the review list, never the trusted list', async () => {
    const stored = storedConfig({ trustedDomains: ['t.example'], allowedDomains: ['t.example', 'example.com'] });
    const { adapters, repo } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { allowedDomains: ['new.example'] }, adapters);
    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
      expect.objectContaining({
        trustedDomains: ['t.example'],
        reviewDomains: ['new.example'],
        unlistedSources: 'drop',
      })
    );
  });

  it('turns an old-tab emptied site list into other-sites-to-review, keeping the review list', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { allowedDomains: [] }, adapters);
    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
      expect.objectContaining({ reviewDomains: ['example.com'], unlistedSources: 'review', allowedDomains: [] })
    );
  });

  it('uses the tier fields and ignores allowedDomains when both shapes are sent', async () => {
    const { adapters, repo } = makeAdapters();
    await updateResearchConfig(
      'config-1',
      lake(),
      actor(),
      NO_GRANTS,
      { reviewDomains: ['new.example'], allowedDomains: ['ignored.example'] },
      adapters
    );
    expect(repo.updateConfig).toHaveBeenCalledWith(
      'config-1',
      LAKE_ID,
      expect.objectContaining({ reviewDomains: ['new.example'], allowedDomains: ['new.example'] })
    );
  });
});

describe('research config auto-admit', () => {
  const stored = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
    storedConfig({ trustedDomains: ['example.com'], unlistedSources: 'review', ...overrides });
  const update = (existing: IDataLakeResearchConfigDocument, input: Parameters<typeof updateResearchConfig>[4]) => {
    const made = makeAdapters({ findByIdInLake: vi.fn(async () => existing) });
    return { ...made, run: () => updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, input, made.adapters) };
  };

  it('stores the opt-in and clamps the cap, defaulting to off', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters);
    expect(repo.createConfig.mock.calls[0][0]).toMatchObject({
      autoAdmitTrusted: false,
      maxAutoAdmits: RESEARCH_MAX_AUTO_ADMITS_DEFAULT,
    });
    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', trustedDomains: ['example.com'], autoAdmitTrusted: true, maxAutoAdmits: 9_999 },
      adapters
    );
    expect(repo.createConfig.mock.calls[1][0]).toMatchObject({
      autoAdmitTrusted: true,
      maxAutoAdmits: RESEARCH_MAX_AUTO_ADMITS_LIMIT,
    });
  });

  it.each(['com', 'github.io', 'co.uk'])('refuses the public suffix %s as a trusted site while on', async entry => {
    const { adapters } = makeAdapters();
    await expect(
      createResearchConfig(
        lake(),
        actor(),
        NO_GRANTS,
        { name: 'n', query: 'q', trustedDomains: [entry], autoAdmitTrusted: true },
        adapters
      )
    ).rejects.toThrow(new RegExp(entry.replace('.', '\\.')));
  });

  it('saves the same list while auto-admit is off', async () => {
    const { adapters, repo } = makeAdapters();
    await createResearchConfig(
      lake(),
      actor(),
      NO_GRANTS,
      { name: 'n', query: 'q', trustedDomains: ['com'], autoAdmitTrusted: false },
      adapters
    );
    expect(repo.createConfig.mock.calls[0][0].trustedDomains).toEqual(['com']);
  });

  it('refuses a toggle-only edit that would enable a stored public suffix', async () => {
    const { run, repo } = update(stored({ trustedDomains: ['com'] }), { autoAdmitTrusted: true });
    await expect(run()).rejects.toThrow(/"com"/);
    expect(repo.updateConfig).not.toHaveBeenCalled();
  });

  it('records an auto-admit entry alongside the update when it flips on', async () => {
    const { run, record } = update(stored(), { autoAdmitTrusted: true });
    await run();
    expect(record.mock.calls[0][0].changes).toEqual([
      { field: 'researchConfig', kind: 'literal', after: 'updated: Weekly sweep' },
      { field: 'researchConfig', kind: 'literal', after: 'auto-admit on: Weekly sweep' },
    ]);
  });

  it('records an auto-admit off entry when it flips off', async () => {
    const { run, record } = update(stored({ autoAdmitTrusted: true }), { autoAdmitTrusted: false });
    await run();
    expect(record.mock.calls[0][0].changes[1]).toMatchObject({ after: 'auto-admit off: Weekly sweep' });
  });

  it('records the entries added and removed when the trusted list changes', async () => {
    const { run, record } = update(stored(), { trustedDomains: ['example.org'] });
    await run();
    expect(record.mock.calls[0][0].changes[1]).toMatchObject({
      after: 'trusted sites added example.org; removed example.com: Weekly sweep',
    });
  });

  it('records nothing for a no-op resubmit', async () => {
    const { run, record } = update(
      stored({ autoAdmitTrusted: true, maxAutoAdmits: RESEARCH_MAX_AUTO_ADMITS_DEFAULT }),
      {
        autoAdmitTrusted: true,
        trustedDomains: ['example.com'],
      }
    );
    await run();
    expect(record).not.toHaveBeenCalled();
  });

  it('counts a cap change as an edit', async () => {
    const { run, record } = update(stored({ autoAdmitTrusted: true }), { maxAutoAdmits: 7 });
    await run();
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('research config feed source', () => {
  const FEED = 'https://example.com/feeds/papers.xml?token=secret';
  const update = (existing: IDataLakeResearchConfigDocument, input: Parameters<typeof updateResearchConfig>[4]) => {
    const made = makeAdapters({ findByIdInLake: vi.fn(async () => existing) });
    return { ...made, run: () => updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, input, made.adapters) };
  };
  const create = (input: Record<string, unknown>) => {
    const made = makeAdapters();
    return {
      ...made,
      run: () => createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', ...input }, made.adapters),
    };
  };

  it('stores a feed config with its topic and address, and defaults a search config to search', async () => {
    const feed = create({ source: 'feed', feedUrl: `  ${FEED}  ` });
    await feed.run();
    expect(feed.repo.createConfig.mock.calls[0][0]).toMatchObject({ source: 'feed', feedUrl: FEED, query: 'q' });

    const search = create({});
    await search.run();
    expect(search.repo.createConfig.mock.calls[0][0]).toMatchObject({ source: 'search', feedUrl: null });
  });

  it('nulls a stray feed address on a search config', async () => {
    const { run, repo } = create({ source: 'search', feedUrl: FEED });
    await run();
    expect(repo.createConfig.mock.calls[0][0]).toMatchObject({ source: 'search', feedUrl: null });
  });

  it.each([
    ['no address', { source: 'feed' }, /needs a feed address/],
    ['a blank address', { source: 'feed', feedUrl: '   ' }, /needs a feed address/],
    ['a null address', { source: 'feed', feedUrl: null }, /needs a feed address/],
    ['an ftp address', { source: 'feed', feedUrl: 'ftp://example.com/feed.xml' }, /http:\/\/ or https:\/\//],
    ['a relative address', { source: 'feed', feedUrl: '/feed.xml' }, /not a valid web address/],
    ['credentials', { source: 'feed', feedUrl: 'https://user:pass@example.com/feed.xml' }, /username or password/],
    ['a username only', { source: 'feed', feedUrl: 'https://user@example.com/feed.xml' }, /username or password/],
    [
      'an address over the cap',
      { source: 'feed', feedUrl: `https://example.com/${'a'.repeat(RESEARCH_FEED_URL_MAX_CHARS)}` },
      /longer than/,
    ],
  ])('refuses %s on create with a 400 naming the problem', async (_label, input, message) => {
    const { run, repo } = create(input);
    await expect(run()).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(message) });
    expect(repo.createConfig).not.toHaveBeenCalled();
  });

  it('refuses a switch to feed with no address, and a stored feed whose address is edited to a bad one', async () => {
    const toFeed = update(storedConfig(), { source: 'feed' });
    await expect(toFeed.run()).rejects.toThrow(/needs a feed address/);
    expect(toFeed.repo.updateConfig).not.toHaveBeenCalled();

    const bad = update(storedConfig({ source: 'feed', feedUrl: FEED }), { feedUrl: 'ftp://example.com/x' });
    await expect(bad.run()).rejects.toThrow(/http/);
  });

  it('keeps the query and nulls the address when a feed config is toggled back to search', async () => {
    const { run, repo } = update(storedConfig({ source: 'feed', feedUrl: FEED }), { source: 'search' });
    await run();
    expect(repo.updateConfig.mock.calls[0][2]).toMatchObject({
      source: 'search',
      feedUrl: null,
      query: 'coastal erosion',
    });
  });

  it('never sends the stored cursor back through the lever write', async () => {
    const cursor = { fingerprint: 'fp', newestPublishedAt: null, seenKeys: ['k'], retries: [] };
    const { run, repo } = update(storedConfig({ source: 'feed', feedUrl: FEED, feedCursor: cursor }), { query: 'new' });
    await run();
    expect(repo.updateConfig.mock.calls[0][2]).not.toHaveProperty('feedCursor');
  });

  it('records the source change with origin and path only, never the query string', async () => {
    const { run, record } = update(storedConfig(), { source: 'feed', feedUrl: FEED });
    await run();
    const entry = record.mock.calls[0][0].changes[1];
    expect(entry).toMatchObject({ after: 'source: feed https://example.com/feeds/papers.xml: Weekly sweep' });
    expect(JSON.stringify(record.mock.calls[0][0].changes)).not.toContain('secret');
  });

  it('records a switch back to web search and a change of feed address', async () => {
    const back = update(storedConfig({ source: 'feed', feedUrl: FEED }), { source: 'search' });
    await back.run();
    expect(back.record.mock.calls[0][0].changes[1]).toMatchObject({ after: 'source: web search: Weekly sweep' });

    const moved = update(storedConfig({ source: 'feed', feedUrl: FEED }), { feedUrl: 'https://example.com/other.xml' });
    await moved.run();
    expect(moved.record.mock.calls[0][0].changes[1]).toMatchObject({
      after: 'source: feed https://example.com/other.xml: Weekly sweep',
    });
  });

  it('records nothing on a no-op resubmit of a feed config', async () => {
    const { run, record } = update(storedConfig({ source: 'feed', feedUrl: FEED }), {
      source: 'feed',
      feedUrl: FEED,
      query: 'coastal erosion',
    });
    await run();
    expect(record).not.toHaveBeenCalled();
  });

  it('adds no source entry when only another lever changes on a feed config', async () => {
    const { run, record } = update(storedConfig({ source: 'feed', feedUrl: FEED }), { minRelevance: 0.9 });
    await run();
    const lines = record.mock.calls[0][0].changes.map((c: { after: string }) => c.after);
    expect(lines).toHaveLength(2);
    expect(lines.some((l: string) => l.startsWith('source:'))).toBe(false);
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

describe('research config item rules', () => {
  const rule = (condition: string, action: 'block' | 'review' = 'block') => ({ condition, action });
  const stored = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) => storedConfig(overrides);
  const update = (existing: IDataLakeResearchConfigDocument, input: Parameters<typeof updateResearchConfig>[4]) => {
    const made = makeAdapters({ findByIdInLake: vi.fn(async () => existing) });
    return { ...made, run: () => updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, input, made.adapters) };
  };
  const create = (itemRules: unknown[]) => {
    const made = makeAdapters();
    return {
      ...made,
      run: () =>
        createResearchConfig(
          lake(),
          actor(),
          NO_GRANTS,
          { name: 'n', query: 'q', itemRules } as Parameters<typeof createResearchConfig>[3],
          made.adapters
        ),
    };
  };
  const many = (count: number) => Array.from({ length: count }, (_, i) => rule(`rule ${i}`));
  const ruleChanges = (calls: unknown[][]) =>
    (calls[0]?.[0] as { changes: { after: string }[] } | undefined)?.changes.filter(change =>
      change.after.startsWith('item rules')
    ) ?? [];

  it('stores trimmed rules on create', async () => {
    const { run, repo } = create([rule('  Published by Acme  ', 'review')]);
    await run();
    expect(repo.createConfig.mock.calls[0][0].itemRules).toEqual([rule('Published by Acme', 'review')]);
  });

  it.each([
    ['11 rules', many(11)],
    ['a 301-character condition', [rule('x'.repeat(301))]],
  ])('refuses %s on create and on update', async (_label, rules) => {
    const created = create(rules);
    await expect(created.run()).rejects.toThrow(/item rule/);
    expect(created.repo.createConfig).not.toHaveBeenCalled();
    const updated = update(stored(), { itemRules: rules as never });
    await expect(updated.run()).rejects.toThrow(/item rule/);
    expect(updated.repo.updateConfig).not.toHaveBeenCalled();
  });

  it('accepts 11 entries when one is a duplicate, and a 300-character condition', async () => {
    const { run, repo } = create([...many(10), rule('RULE 0 ')]);
    await run();
    expect(repo.createConfig.mock.calls[0][0].itemRules).toHaveLength(10);
    const long = create([rule('x'.repeat(300))]);
    await expect(long.run()).resolves.toBeDefined();
  });

  it('counts and length-checks the cleaned conditions', async () => {
    const { run, repo } = create([...many(10), rule('\u200B\u200B')]);
    await run();
    expect(repo.createConfig.mock.calls[0][0].itemRules).toHaveLength(10);
    const padded = create([rule('x'.repeat(300) + '\u200B'.repeat(20))]);
    await expect(padded.run()).resolves.toBeDefined();
  });

  it('treats a reordered or re-cased resubmit as a no-op with no history entry', async () => {
    const { run, record, repo } = update(stored({ itemRules: [rule('A one'), rule('b two', 'review')] }), {
      itemRules: [rule('B TWO', 'review'), rule(' a one ')],
    });
    await run();
    expect(record).not.toHaveBeenCalled();
    expect(repo.updateConfig).toHaveBeenCalled();
  });

  it('writes one entry with counts when rules are added and removed', async () => {
    const { run, record } = update(stored({ itemRules: [rule('a'), rule('b')] }), {
      itemRules: [rule('b'), rule('c'), rule('d', 'review')],
    });
    await run();
    expect(ruleChanges(record.mock.calls)).toEqual([
      { field: 'researchConfig', kind: 'literal', after: 'item rules 2 added, 1 removed: Weekly sweep' },
    ]);
  });

  it('keeps stored rules when an edit does not mention them', async () => {
    const { run, record, repo } = update(stored({ itemRules: [rule('a')] }), { query: 'other' });
    await run();
    expect(repo.updateConfig.mock.calls[0][2].itemRules).toEqual([rule('a')]);
    expect(ruleChanges(record.mock.calls)).toEqual([]);
  });

  it('flipping an action alone is one removed and one added', async () => {
    const { run, record } = update(stored({ itemRules: [rule('a', 'block')] }), { itemRules: [rule('a', 'review')] });
    await run();
    expect(ruleChanges(record.mock.calls)[0]).toMatchObject({
      after: 'item rules 1 added, 1 removed: Weekly sweep',
    });
  });

  it('records the count on create when there are rules, and nothing when there are none', async () => {
    const withRules = create([rule('a'), rule('b'), rule('c', 'review')]);
    await withRules.run();
    expect(ruleChanges(withRules.record.mock.calls)).toEqual([
      { field: 'researchConfig', kind: 'literal', after: 'item rules 3 added: n' },
    ]);
    const none = create([]);
    await none.run();
    expect(ruleChanges(none.record.mock.calls)).toEqual([]);
  });
});

describe('research schedule pause', () => {
  const ANCHOR = new Date('2026-03-08T12:00:00.000Z');
  const weekly = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
    storedConfig({
      cadence: 'weekly',
      trigger: 'periodic',
      nextRunAt: ANCHOR,
      scheduleAnchorAt: ANCHOR,
      ...overrides,
    });
  const adaptersFor = (stored: IDataLakeResearchConfigDocument) =>
    makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
  const setPaused = (stored: IDataLakeResearchConfigDocument, paused: boolean) => {
    const made = adaptersFor(stored);
    return {
      ...made,
      run: () => setResearchSchedulePaused('config-1', lake(), paused, actor(), NO_GRANTS, made.adapters),
    };
  };
  const patchOf = (repo: ReturnType<typeof makeAdapters>['repo']) =>
    repo.updateConfig.mock.calls[0][2] as Record<string, unknown>;
  const historyEntries = (record: ReturnType<typeof makeAdapters>['record']) =>
    (record.mock.calls as unknown as [{ changes: { after: string }[] }][]).flatMap(([event]) =>
      event.changes.map(change => change.after)
    );

  describe('setResearchSchedulePaused', () => {
    it('writes only the flag on pause, keeping cadence, next run and anchor, and records History', async () => {
      const { run, repo, record } = setPaused(weekly(), true);
      await run();
      expect(patchOf(repo)).toEqual({ schedulePaused: true, lastUpdatedByUserId: ACTOR_ID });
      expect(historyEntries(record)).toEqual(['research schedule paused: Weekly sweep']);
    });

    it('resumes before the first run on the anchor', async () => {
      const { run, repo, record } = setPaused(weekly({ schedulePaused: true }), false);
      await run();
      expect(patchOf(repo)).toMatchObject({ schedulePaused: false, nextRunAt: ANCHOR });
      expect(historyEntries(record)).toEqual(['research schedule resumed: Weekly sweep']);
    });

    it('keeps a pending one-hour retry across a pause and resume', async () => {
      const retryAt = new Date('2026-03-01T12:40:00.000Z');
      const stored = weekly({ nextRunAt: retryAt, scheduleAnchorAt: new Date('2026-02-22T09:00:00.000Z') });
      const paused = setPaused(stored, true);
      await paused.run();
      expect(patchOf(paused.repo)).not.toHaveProperty('nextRunAt');

      const resumed = setPaused({ ...stored, schedulePaused: true }, false);
      await resumed.run();
      expect(patchOf(resumed.repo).nextRunAt).toEqual(retryAt);
    });

    it('keeps a future next run left by a tick that claimed before the pause', async () => {
      const lease = new Date('2026-03-01T12:10:00.000Z');
      const { run, repo } = setPaused(weekly({ schedulePaused: true, nextRunAt: lease }), false);
      await run();
      expect(patchOf(repo).nextRunAt).toEqual(lease);
    });

    it('lands the next regular slot after a long pause, not an immediate run', async () => {
      const stored = weekly({
        cadence: 'daily',
        schedulePaused: true,
        nextRunAt: new Date('2026-02-01T09:00:00.000Z'),
        scheduleAnchorAt: new Date('2026-01-01T09:00:00.000Z'),
      });
      const { run, repo } = setPaused(stored, false);
      await run();
      expect(patchOf(repo).nextRunAt).toEqual(new Date('2026-03-02T09:00:00.000Z'));
    });

    it('clears a schedule_paused outcome on resume, and only that one', async () => {
      const at = new Date('2026-03-01T09:00:00.000Z');
      const cleared = setPaused(
        weekly({
          schedulePaused: true,
          lastScheduledOutcome: { outcome: 'skipped', at, reason: 'schedule_paused' },
        }),
        false
      );
      await cleared.run();
      expect(patchOf(cleared.repo)).toMatchObject({ lastScheduledOutcome: null });

      const kept = setPaused(
        weekly({ schedulePaused: true, lastScheduledOutcome: { outcome: 'skipped', at, reason: 'daily_cap' } }),
        false
      );
      await kept.run();
      expect(patchOf(kept.repo)).not.toHaveProperty('lastScheduledOutcome');
    });

    it('can still pause a config whose levers would now fail validation', async () => {
      const stale = weekly({ autoAdmitTrusted: true, trustedDomains: ['com'] });
      const { adapters } = adaptersFor(stale);
      await expect(
        updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { query: 'same' }, adapters)
      ).rejects.toThrow(/covers every site/);

      const { run, repo } = setPaused(stale, true);
      await run();
      expect(patchOf(repo)).toMatchObject({ schedulePaused: true });
    });

    it('refuses to pause a config with no cadence', async () => {
      const { run, repo } = setPaused(storedConfig(), true);
      await expect(run()).rejects.toThrow(/needs a cadence/);
      expect(repo.updateConfig).not.toHaveBeenCalled();
    });

    it('writes nothing when the flag already has the requested value', async () => {
      const { run, repo, record } = setPaused(weekly({ schedulePaused: true }), true);
      await run();
      expect(repo.updateConfig).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('404s on a config that is not in this lake', async () => {
      const made = makeAdapters({ findByIdInLake: vi.fn(async () => null) });
      await expect(
        setResearchSchedulePaused('config-1', lake(), true, actor(), NO_GRANTS, made.adapters)
      ).rejects.toThrow(/not found/);
    });

    it('lets a repository error other than not-found propagate, so a write conflict can retry', async () => {
      const conflict = Object.assign(new Error('write conflict'), { code: 112 });
      const made = makeAdapters({
        findByIdInLake: vi.fn(async () => weekly()),
        updateConfig: vi.fn(async () => {
          throw conflict;
        }),
      });
      await expect(setResearchSchedulePaused('config-1', lake(), true, actor(), NO_GRANTS, made.adapters)).rejects.toBe(
        conflict
      );
    });
  });

  describe('updateResearchConfig', () => {
    it('applies a lever change and the pause from one mixed body', async () => {
      const { adapters, repo, record } = adaptersFor(weekly());
      await updateResearchConfig(
        'config-1',
        lake(),
        actor(),
        NO_GRANTS,
        { schedulePaused: true, query: 'new question' },
        adapters
      );
      expect(patchOf(repo)).toMatchObject({ schedulePaused: true, query: 'new question' });
      expect(historyEntries(record)).toEqual(
        expect.arrayContaining(['updated: Weekly sweep', 'research schedule paused: Weekly sweep'])
      );
    });

    it('records a pause-only change in History even though no lever moved', async () => {
      const { adapters, record } = adaptersFor(weekly());
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { schedulePaused: true }, adapters);
      expect(historyEntries(record)).toEqual(['research schedule paused: Weekly sweep']);
    });

    it('does not record the pause entry when the flag is unchanged', async () => {
      const { adapters, record } = adaptersFor(weekly({ schedulePaused: true }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { schedulePaused: true }, adapters);
      expect(record).not.toHaveBeenCalled();
    });

    it('records one History row naming the old and new cadence', async () => {
      const toOff = adaptersFor(weekly());
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'off' }, toOff.adapters);
      expect(historyEntries(toOff.record)).toEqual(['research schedule weekly -> off: Weekly sweep']);

      const toDaily = adaptersFor(weekly({ cadence: 'off', trigger: 'manual' }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'daily' }, toDaily.adapters);
      expect(historyEntries(toDaily.record)).toEqual(['research schedule off -> daily: Weekly sweep']);
    });

    it('records one History row naming the old and new review backlog limit', async () => {
      const { adapters, record } = adaptersFor(weekly({ reviewBacklogLimit: 25 }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { reviewBacklogLimit: 40 }, adapters);
      expect(historyEntries(record)).toEqual(['review backlog limit 25 -> 40: Weekly sweep']);
    });

    it('records nothing when cadence and backlog limit are resubmitted unchanged', async () => {
      const { adapters, record } = adaptersFor(weekly({ reviewBacklogLimit: 40 }));
      await updateResearchConfig(
        'config-1',
        lake(),
        actor(),
        NO_GRANTS,
        { cadence: 'weekly', reviewBacklogLimit: 40 },
        adapters
      );
      expect(record).not.toHaveBeenCalled();
    });

    it('resumes with the same next-run rule as the narrow write', async () => {
      const retryAt = new Date('2026-03-01T12:40:00.000Z');
      const { adapters, repo } = adaptersFor(weekly({ schedulePaused: true, nextRunAt: retryAt }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { schedulePaused: false }, adapters);
      expect(patchOf(repo)).toMatchObject({ schedulePaused: false, nextRunAt: retryAt });
    });

    it('refuses schedulePaused true while the resulting cadence is off', async () => {
      const { adapters, repo } = makeAdapters();
      await expect(
        updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { schedulePaused: true }, adapters)
      ).rejects.toThrow(/needs a cadence/);
      await expect(
        updateResearchConfig(
          'config-1',
          lake(),
          actor(),
          NO_GRANTS,
          { schedulePaused: true, cadence: 'off' },
          adaptersFor(weekly()).adapters
        )
      ).rejects.toThrow(/needs a cadence/);
      expect(repo.updateConfig).not.toHaveBeenCalled();
    });

    it('keeps the pause across a cadence change and clears it when the cadence goes off', async () => {
      const changed = adaptersFor(weekly({ schedulePaused: true }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'daily' }, changed.adapters);
      expect(patchOf(changed.repo)).toMatchObject({ cadence: 'daily', nextRunAt: expect.any(Date) });
      expect(patchOf(changed.repo)).not.toHaveProperty('schedulePaused');

      const off = adaptersFor(weekly({ schedulePaused: true }));
      await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'off' }, off.adapters);
      expect(patchOf(off.repo)).toMatchObject({ cadence: 'off', schedulePaused: false });
      expect(historyEntries(off.record).some(entry => entry.startsWith('research schedule resumed'))).toBe(false);
    });
  });

  describe('createResearchConfig', () => {
    it('persists a paused schedule', async () => {
      const { adapters, repo } = makeAdapters();
      await createResearchConfig(
        lake(),
        actor(),
        NO_GRANTS,
        { name: 'n', query: 'q', cadence: 'weekly', schedulePaused: true },
        adapters
      );
      expect(repo.createConfig.mock.calls[0][0]).toMatchObject({ cadence: 'weekly', schedulePaused: true });
    });

    it('defaults to not paused, and refuses a paused config with no cadence', async () => {
      const { adapters, repo } = makeAdapters();
      await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q' }, adapters);
      expect(repo.createConfig.mock.calls[0][0]).toMatchObject({ schedulePaused: false });
      await expect(
        createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'n', query: 'q', schedulePaused: true }, adapters)
      ).rejects.toThrow(/needs a cadence/);
    });
  });
});

describe('structured History and config snapshots', () => {
  const FEED_QS = 'https://example.com/feed.xml?token=secret-abc';

  it('records target and a redacted lever snapshot on delete, plus the full config as a snapshot', async () => {
    const stored = storedConfig({ source: 'feed', feedUrl: FEED_QS, cadence: 'daily' });
    const { adapters, record, snapshotRecord } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });

    await deleteResearchConfig('config-1', lake(), actor(), NO_GRANTS, adapters);

    const input = record.mock.calls[0][0] as { target: unknown; leverChanges: { after: unknown }[] };
    expect(input.target).toEqual({ kind: 'researchConfig', id: 'config-1' });
    expect(input.leverChanges.every(c => c.after === null)).toBe(true);
    expect(JSON.stringify(input)).not.toContain('secret-abc');
    expect(snapshotRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: LAKE_ID,
        eventId: 'evt-1',
        kind: 'config-deleted',
        config: expect.objectContaining({ feedUrl: FEED_QS }),
      })
    );
  });

  it('writes the full before and after feed address to a snapshot on a feed edit, never to History', async () => {
    const stored = storedConfig({ source: 'feed', feedUrl: FEED_QS });
    const next = 'https://example.com/other.xml?key=second';
    const { adapters, record, snapshotRecord } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });

    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { feedUrl: next }, adapters);

    expect(snapshotRecord).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-1', kind: 'feed-url-edited', feedUrlBefore: FEED_QS, feedUrlAfter: next })
    );
    const out = JSON.stringify(record.mock.calls[0][0]);
    expect(out).not.toContain('secret-abc');
    expect(out).not.toContain('second');
  });

  it('writes no snapshot when the feed address did not move', async () => {
    const { adapters, snapshotRecord } = makeAdapters();
    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { minRelevance: 0.9 }, adapters);
    expect(snapshotRecord).not.toHaveBeenCalled();
  });

  it('survives a failing snapshot write', async () => {
    const stored = storedConfig({ source: 'feed', feedUrl: FEED_QS });
    const { adapters, snapshotRecord } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });
    snapshotRecord.mockRejectedValueOnce(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { feedUrl: 'https://example.com/b.xml' }, adapters)
    ).resolves.toBeDefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('records the schedulePaused flip when an edit sets cadence off', async () => {
    const stored = storedConfig({ cadence: 'daily', schedulePaused: true });
    const { adapters, record } = makeAdapters({ findByIdInLake: vi.fn(async () => stored) });

    await updateResearchConfig('config-1', lake(), actor(), NO_GRANTS, { cadence: 'off' }, adapters);

    const input = record.mock.calls[0][0] as { leverChanges: { lever: string; before: unknown; after: unknown }[] };
    expect(input.leverChanges).toEqual(
      expect.arrayContaining([{ lever: 'schedulePaused', before: true, after: false }])
    );
  });

  it('records target on create', async () => {
    const { adapters, record } = makeAdapters();
    await createResearchConfig(lake(), actor(), NO_GRANTS, { name: 'Weekly', query: 'erosion' }, adapters);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'researchConfig', id: 'new' } }));
  });
});
