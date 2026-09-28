import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeResearchConfigDocument } from '@bike4mind/common';
import {
  addCadence,
  nextResearchRunAfter,
  RESEARCH_SCHEDULE_BATCH_MAX,
  RESEARCH_SCHEDULE_LEASE_MS,
  RESEARCH_SCHEDULE_RETRY_MS,
  runDueResearchSchedules,
  type ResearchScheduleAdapters,
} from './researchSchedule';

const NOW = new Date('2026-03-10T09:05:00.000Z');
const DUE_AT = new Date('2026-03-10T09:00:00.000Z');

const scheduledConfig = (overrides: Partial<IDataLakeResearchConfigDocument> = {}) =>
  ({
    id: 'config-1',
    dataLakeId: 'lake-1',
    name: 'Daily sweep',
    trigger: 'periodic',
    cadence: 'daily',
    reviewBacklogLimit: 10,
    nextRunAt: DUE_AT,
    createdByUserId: 'user-1',
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
    due?: IDataLakeResearchConfigDocument[];
    pending?: Record<string, number>;
    active?: number;
    enqueue?: ResearchScheduleAdapters['enqueue'];
    recordScheduleOutcome?: ReturnType<typeof vi.fn>;
  } = {}
) => {
  const due = overrides.due ?? [scheduledConfig()];
  const configs = {
    claimDueConfigs: vi.fn(async () => due),
    recordScheduleOutcome: overrides.recordScheduleOutcome ?? vi.fn(async () => {}),
    findByIdInLake: vi.fn(async (id: string) => due.find(c => c.id === id) ?? null),
    recordRunStarted: vi.fn(async () => {}),
  };
  const runs = {
    createRun: vi.fn(async (input: { configId: string }) => ({ id: `run-of-${input.configId}`, ...input })),
    countActiveByLake: vi.fn(async () => overrides.active ?? 0),
    countStartedSince: vi.fn(async () => 0),
  };
  const proposals = { countPendingByLakes: vi.fn(async () => overrides.pending ?? {}) };
  const enqueue = vi.fn(overrides.enqueue ?? (async () => {}));
  const logger = { info: vi.fn(), error: vi.fn() };
  const adapters = {
    db: { dataLakeResearchConfigs: configs, dataLakeResearchRuns: runs, dataLakeProposals: proposals },
    enqueue,
    logger,
    now: () => NOW,
  } as unknown as ResearchScheduleAdapters;
  return { adapters, configs, runs, proposals, enqueue, logger };
};

describe('addCadence', () => {
  it('steps a month on the calendar, clamping to the last day of a shorter month', () => {
    expect(addCadence('monthly', new Date('2026-01-31T08:00:00.000Z'))).toEqual(new Date('2026-02-28T08:00:00.000Z'));
    expect(addCadence('monthly', new Date('2026-12-15T08:00:00.000Z'))).toEqual(new Date('2027-01-15T08:00:00.000Z'));
  });
});

describe('nextResearchRunAfter', () => {
  it('anchors on the slot that came due, not on when the tick ran', () => {
    expect(nextResearchRunAfter('daily', DUE_AT, NOW)).toEqual(new Date('2026-03-11T09:00:00.000Z'));
  });

  // A scheduler that was down for a week must not come back to seven catch-up runs.
  it('steps past now after an outage instead of returning a slot already in the past', () => {
    const weekLate = new Date('2026-03-17T10:00:00.000Z');
    expect(nextResearchRunAfter('daily', DUE_AT, weekLate)).toEqual(new Date('2026-03-18T09:00:00.000Z'));
  });

  it('returns to the anchor day of the month after clamping to a shorter month', () => {
    const jan31 = new Date('2026-01-31T08:00:00.000Z');
    expect(nextResearchRunAfter('monthly', jan31, new Date('2026-02-01T00:00:00.000Z'))).toEqual(
      new Date('2026-02-28T08:00:00.000Z')
    );
    expect(nextResearchRunAfter('monthly', jan31, new Date('2026-02-28T09:00:00.000Z'))).toEqual(
      new Date('2026-03-31T08:00:00.000Z')
    );
  });
});

describe('runDueResearchSchedules', () => {
  it('claims due configs under a lease and starts a periodic run for each', async () => {
    const { adapters, configs, runs, enqueue } = makeAdapters();

    const summary = await runDueResearchSchedules(adapters);

    expect(configs.claimDueConfigs).toHaveBeenCalledWith(
      NOW,
      new Date(NOW.getTime() + RESEARCH_SCHEDULE_LEASE_MS),
      RESEARCH_SCHEDULE_BATCH_MAX
    );
    expect(runs.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'periodic', startedByUserId: null })
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-of-config-1' }));
    expect(configs.recordScheduleOutcome).toHaveBeenCalledWith(
      'config-1',
      'daily',
      { outcome: 'started', at: NOW, runId: 'run-of-config-1' },
      new Date('2026-03-11T09:00:00.000Z')
    );
    expect(summary).toEqual({ claimed: 1, started: 1, skipped: 0, failed: 0 });
  });

  it('skips a lake whose pending proposals are at the limit, without writing a run or spending', async () => {
    const { adapters, configs, runs, enqueue } = makeAdapters({ pending: { 'lake-1': 10 } });

    const summary = await runDueResearchSchedules(adapters);

    expect(runs.createRun).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(configs.recordScheduleOutcome).toHaveBeenCalledWith(
      'config-1',
      'daily',
      { outcome: 'skipped', at: NOW, reason: 'review_backlog', pendingProposals: 10, reviewBacklogLimit: 10 },
      // The next regular slot: the run resumes on its own once someone has reviewed the queue.
      new Date('2026-03-11T09:00:00.000Z')
    );
    expect(summary.skipped).toBe(1);
  });

  it('lets the next due run go ahead once the queue drops below the limit', async () => {
    const { adapters, runs } = makeAdapters({ pending: { 'lake-1': 9 } });

    const summary = await runDueResearchSchedules(adapters);

    expect(runs.createRun).toHaveBeenCalledTimes(1);
    expect(summary.started).toBe(1);
  });

  it('skips and retries within the hour when another run is still in flight', async () => {
    const { adapters, configs, runs } = makeAdapters({ active: 1 });

    await runDueResearchSchedules(adapters);

    expect(runs.createRun).not.toHaveBeenCalled();
    expect(configs.recordScheduleOutcome).toHaveBeenCalledWith(
      'config-1',
      'daily',
      { outcome: 'skipped', at: NOW, reason: 'run_in_progress' },
      new Date(NOW.getTime() + RESEARCH_SCHEDULE_RETRY_MS)
    );
  });

  // A retried tick fires off-slot; the run that finally starts must not make that the new cadence.
  it('steps from the anchor, not from a retry time, once a retried run starts', async () => {
    const retriedAt = new Date(DUE_AT.getTime() + RESEARCH_SCHEDULE_RETRY_MS);
    const due = [scheduledConfig({ scheduleAnchorAt: new Date('2026-03-09T08:00:00.000Z'), nextRunAt: retriedAt })];
    const { adapters, configs } = makeAdapters({ due });

    await runDueResearchSchedules(adapters);

    const [, , outcome, nextRunAt] = configs.recordScheduleOutcome.mock.calls[0];
    expect(outcome).toMatchObject({ outcome: 'started' });
    expect(nextRunAt).toEqual(new Date('2026-03-11T08:00:00.000Z'));
  });

  it('records a failed start visibly and retries, without leaking the raw error to the card', async () => {
    const { adapters, configs, logger } = makeAdapters({
      enqueue: async () => {
        throw new Error('sqs: connect ECONNREFUSED 10.0.0.1');
      },
    });

    const summary = await runDueResearchSchedules(adapters);

    const [, , outcome, nextRunAt] = configs.recordScheduleOutcome.mock.calls[0];
    expect(outcome).toMatchObject({ outcome: 'failed', at: NOW });
    expect(outcome.error).not.toMatch(/ECONNREFUSED/);
    expect(nextRunAt).toEqual(new Date(NOW.getTime() + RESEARCH_SCHEDULE_RETRY_MS));
    expect(logger.error).toHaveBeenCalled();
    expect(summary.failed).toBe(1);
  });

  it('keeps going past one lake that faults', async () => {
    const due = [scheduledConfig({ id: 'broken', dataLakeId: 'lake-x' }), scheduledConfig({ id: 'healthy' })];
    const { adapters, proposals, runs } = makeAdapters({ due });
    proposals.countPendingByLakes.mockImplementation(async (ids: string[]) => {
      if (ids[0] === 'lake-x') throw new Error('mongo blip');
      return {};
    });

    const summary = await runDueResearchSchedules(adapters);

    expect(runs.createRun).toHaveBeenCalledWith(expect.objectContaining({ configId: 'healthy' }));
    expect(summary).toEqual({ claimed: 2, started: 1, skipped: 0, failed: 1 });
  });

  it('logs rather than throws when the outcome cannot be recorded', async () => {
    const recordScheduleOutcome = vi.fn(async () => {
      throw new Error('write failed');
    });
    const { adapters, logger } = makeAdapters({ recordScheduleOutcome });

    await expect(runDueResearchSchedules(adapters)).resolves.toMatchObject({ started: 1 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('could not record'), expect.any(Error));
  });
});
