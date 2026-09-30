import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument, IDataLakeResearchConfigDocument } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import type { LakeGrant, ManageActor } from '../dataLakeService/manageRule';
import {
  isResearchRunRefusal,
  RESEARCH_RUNS_PER_LAKE_PER_DAY,
  startResearchRun,
  type StartResearchRunAdapters,
} from './startResearchRun';

const LAKE = 'lake-1';
const ACTOR = 'user-1';
const NOW = new Date('2026-03-01T12:00:00.000Z');

/** No caller wires a grant repo of its own anymore - the route's gate loads grants once and
 * passes them straight in, so every test here supplies them the same way. */
const NO_GRANTS: LakeGrant[] = [];

const lake = (overrides: Partial<IDataLakeDocument> = {}) =>
  ({ id: LAKE, createdByUserId: ACTOR, ...overrides }) as IDataLakeDocument;
const actor = (userId: string = ACTOR): ManageActor => ({ userId, isAdmin: false, administeredOrgIds: [] });
const onDemand = (userId: string = ACTOR, grants: readonly LakeGrant[] = NO_GRANTS) =>
  ({ trigger: 'on_demand', actor: actor(userId), grants }) as const;
const PERIODIC = { trigger: 'periodic' } as const;

const storedConfig = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
  ({
    id: 'config-1',
    dataLakeId: LAKE,
    name: 'Weekly sweep',
    trigger: 'on_demand',
    createdByUserId: ACTOR,
    query: 'coastal erosion',
    maxResults: 10,
    maxProposals: 5,
    allowedDomains: [],
    blockedDomains: [],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: [],
    ...overrides,
  }) as IDataLakeResearchConfigDocument;

const makeAdapters = (
  overrides: {
    config?: IDataLakeResearchConfigDocument | null;
    active?: number;
    startedToday?: number;
  } = {}
) => {
  const configs = {
    findByIdInLake: vi.fn(async () => (overrides.config === undefined ? storedConfig() : overrides.config)),
    recordRunStarted: vi.fn(async () => {}),
  };
  const runs = {
    createRun: vi.fn(async (input: unknown) => ({ id: 'run-1', ...(input as object) })),
    countActiveByLake: vi.fn(async () => overrides.active ?? 0),
    countStartedSince: vi.fn(async () => overrides.startedToday ?? 0),
  };
  const record = vi.fn(async () => undefined);
  const adapters = {
    db: { dataLakeResearchConfigs: configs, dataLakeResearchRuns: runs, lakeConfigChangeEvents: { record } },
    now: () => NOW,
  } as unknown as StartResearchRunAdapters;
  return { adapters, configs, runs, record };
};

describe('startResearchRun', () => {
  it('queues a run carrying a normalized snapshot of the configuration levers', async () => {
    const { adapters, runs } = makeAdapters();

    const run = await startResearchRun('config-1', lake(), onDemand(), adapters);

    expect(run.id).toBe('run-1');
    expect(runs.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: LAKE,
        configId: 'config-1',
        trigger: 'on_demand',
        startedByUserId: ACTOR,
        // Queued, not started: the worker stamps startedAt when it claims the row.
        startedAt: null,
        completedAt: null,
      })
    );
  });

  // The snapshot is what the loop executes AND what the run reports it ran with; copying the stored
  // values raw would make those two disagree for any config written before a bound tightened.
  it('re-clamps the snapshot rather than copying stored values raw', async () => {
    const { adapters, runs } = makeAdapters({ config: storedConfig({ maxResults: 9_999, minRelevance: 7 }) });

    await startResearchRun('config-1', lake(), onDemand(), adapters);

    expect(runs.createRun.mock.calls[0][0].levers).toMatchObject({ maxResults: 50, minRelevance: 1 });
  });

  it('stamps the configuration only after the run row exists', async () => {
    const { adapters, configs, runs } = makeAdapters();

    await startResearchRun('config-1', lake(), onDemand(), adapters);

    expect(configs.recordRunStarted).toHaveBeenCalledWith('config-1', NOW);
    expect(runs.createRun.mock.invocationCallOrder[0]).toBeLessThan(
      configs.recordRunStarted.mock.invocationCallOrder[0]
    );
  });

  it('404s on a configuration that is not in this lake', async () => {
    const { adapters, runs } = makeAdapters({ config: null });
    await expect(startResearchRun('config-1', lake(), onDemand(), adapters)).rejects.toThrow(/not found/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run for the same lake', async () => {
    const { adapters, runs } = makeAdapters({ active: 1 });
    await expect(startResearchRun('config-1', lake(), onDemand(), adapters)).rejects.toThrow(/already in progress/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  // Checked first because it catches the common mistake (a double-clicked Run button) and deserves
  // the clearer of the two messages.
  it('reports the concurrency guard ahead of the daily cap when both would fire', async () => {
    const { adapters } = makeAdapters({ active: 1, startedToday: RESEARCH_RUNS_PER_LAKE_PER_DAY });
    await expect(startResearchRun('config-1', lake(), onDemand(), adapters)).rejects.toThrow(/already in progress/);
  });

  it('refuses once the lake has hit its daily cap', async () => {
    const { adapters, runs } = makeAdapters({ startedToday: RESEARCH_RUNS_PER_LAKE_PER_DAY });
    await expect(startResearchRun('config-1', lake(), onDemand(), adapters)).rejects.toThrow(/already started/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  // Run now on a scheduled config is still a person pressing a button, so the run records how it
  // started rather than copying the config's trigger.
  it('records the trigger and starter of this run, not of the config', async () => {
    const { adapters, runs } = makeAdapters({ config: storedConfig({ trigger: 'periodic', cadence: 'daily' }) });

    await startResearchRun('config-1', lake(), onDemand(), adapters);
    expect(runs.createRun.mock.calls[0][0]).toMatchObject({ trigger: 'on_demand', startedByUserId: ACTOR });

    await startResearchRun('config-1', lake(), PERIODIC, adapters);
    expect(runs.createRun.mock.calls[1][0]).toMatchObject({ trigger: 'periodic', startedByUserId: null });
  });

  // The scheduler reads the reason to decide between "skip and retry soon" and "failed".
  it('names the rail that refused the start', async () => {
    const busy = makeAdapters({ active: 1 });
    await expect(startResearchRun('config-1', lake(), onDemand(), busy.adapters)).rejects.toMatchObject({
      reason: 'run_in_progress',
    });

    const capped = makeAdapters({ startedToday: RESEARCH_RUNS_PER_LAKE_PER_DAY });
    const refusal = await startResearchRun('config-1', lake(), onDemand(), capped.adapters).catch(e => e);
    expect(refusal).toBeInstanceOf(BadRequestError);
    expect(isResearchRunRefusal(refusal)).toBe(true);
    expect(refusal.reason).toBe('daily_cap');
  });

  it('counts the daily cap over a rolling 24 hours from now', async () => {
    const { adapters, runs } = makeAdapters();
    await startResearchRun('config-1', lake(), onDemand(), adapters);
    expect(runs.countStartedSince).toHaveBeenCalledWith(LAKE, new Date('2026-02-28T12:00:00.000Z'));
  });

  // Starting a research run left no trace in the lake's History tab.
  it('records a start-research-run history event naming the configuration', async () => {
    const { adapters, record } = makeAdapters();

    await startResearchRun('config-1', lake(), onDemand(), adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        principalId: ACTOR,
        dataLakeId: LAKE,
        action: 'start-research-run',
        changes: [{ field: 'researchRun', kind: 'literal', after: 'started: coastal erosion (run run-1)' }],
      })
    );
  });

  // Follow-up: pinned so a regression back to an internal re-fetch (which silently returns
  // [] without a wired grant repo) fails loudly instead of quietly mis-stamping every curator.
  it('records the manage rung the passed-in grants actually authorize, not `system`', async () => {
    const { adapters, record } = makeAdapters();
    const curatorGrants: LakeGrant[] = [{ principalType: 'user', principalId: 'curator-1', role: 'curator' }];

    await startResearchRun('config-1', lake(), onDemand('curator-1', curatorGrants), adapters);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ manageRung: 'grant-curator' }));
  });

  // A periodic start has no caller behind it at all, so its History row must not be attributed to
  // whichever user happens to share an empty id - it is stamped explicitly, the same way
  // `recordResearchRunOutcome` stamps its own periodic-safe path.
  it('records a periodic start under the system rung, with no principal', async () => {
    const { adapters, record } = makeAdapters();

    await startResearchRun('config-1', lake(), PERIODIC, adapters);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ manageRung: 'system', principalKind: 'system', action: 'start-research-run' })
    );
  });
});
