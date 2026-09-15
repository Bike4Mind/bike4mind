import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeResearchConfigDocument } from '@bike4mind/common';
import { RESEARCH_RUNS_PER_LAKE_PER_DAY, startResearchRun, type StartResearchRunAdapters } from './startResearchRun';

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
  const adapters = {
    db: { dataLakeResearchConfigs: configs, dataLakeResearchRuns: runs },
    now: () => NOW,
  } as unknown as StartResearchRunAdapters;
  return { adapters, configs, runs };
};

describe('startResearchRun', () => {
  it('queues a run carrying a normalized snapshot of the configuration levers', async () => {
    const { adapters, runs } = makeAdapters();

    const run = await startResearchRun('config-1', LAKE, ACTOR, adapters);

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

    await startResearchRun('config-1', LAKE, ACTOR, adapters);

    expect(runs.createRun.mock.calls[0][0].levers).toMatchObject({ maxResults: 50, minRelevance: 1 });
  });

  it('stamps the configuration only after the run row exists', async () => {
    const { adapters, configs, runs } = makeAdapters();

    await startResearchRun('config-1', LAKE, ACTOR, adapters);

    expect(configs.recordRunStarted).toHaveBeenCalledWith('config-1', NOW);
    expect(runs.createRun.mock.invocationCallOrder[0]).toBeLessThan(
      configs.recordRunStarted.mock.invocationCallOrder[0]
    );
  });

  it('404s on a configuration that is not in this lake', async () => {
    const { adapters, runs } = makeAdapters({ config: null });
    await expect(startResearchRun('config-1', LAKE, ACTOR, adapters)).rejects.toThrow(/not found/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  it('refuses a second concurrent run for the same lake', async () => {
    const { adapters, runs } = makeAdapters({ active: 1 });
    await expect(startResearchRun('config-1', LAKE, ACTOR, adapters)).rejects.toThrow(/already in progress/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  // Checked first because it catches the common mistake (a double-clicked Run button) and deserves
  // the clearer of the two messages.
  it('reports the concurrency guard ahead of the daily cap when both would fire', async () => {
    const { adapters } = makeAdapters({ active: 1, startedToday: RESEARCH_RUNS_PER_LAKE_PER_DAY });
    await expect(startResearchRun('config-1', LAKE, ACTOR, adapters)).rejects.toThrow(/already in progress/);
  });

  it('refuses once the lake has hit its daily cap', async () => {
    const { adapters, runs } = makeAdapters({ startedToday: RESEARCH_RUNS_PER_LAKE_PER_DAY });
    await expect(startResearchRun('config-1', LAKE, ACTOR, adapters)).rejects.toThrow(/already started/);
    expect(runs.createRun).not.toHaveBeenCalled();
  });

  it('counts the daily cap over a rolling 24 hours from now', async () => {
    const { adapters, runs } = makeAdapters();
    await startResearchRun('config-1', LAKE, ACTOR, adapters);
    expect(runs.countStartedSince).toHaveBeenCalledWith(LAKE, new Date('2026-02-28T12:00:00.000Z'));
  });
});
