import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runGenerationJobSweep, connectDB, enqueueGenerationJob } = vi.hoisted(() => ({
  runGenerationJobSweep: vi.fn(async (_deps: { repository: unknown; enqueue: unknown }) => ({ requeued: 2 })),
  connectDB: vi.fn(async () => undefined),
  enqueueGenerationJob: vi.fn(),
}));

vi.mock('@bike4mind/services/generationJobs', () => ({ runGenerationJobSweep }));
vi.mock('@bike4mind/database', () => ({ connectDB, generationJobRepository: { tag: 'repo' } }));
vi.mock('@server/generationJobs/wiring', () => ({ enqueueGenerationJob }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://host/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));

import { runGenerationJobSweepCron } from './generationJobSweep';

describe('generationJobSweep cron', () => {
  beforeEach(() => vi.clearAllMocks());

  it('connects to the stage database before running one sweep', async () => {
    expect(await runGenerationJobSweepCron()).toEqual({ requeued: 2 });
    expect(connectDB).toHaveBeenCalledWith('mongodb://host/test');
    expect(runGenerationJobSweep).toHaveBeenCalledTimes(1);
  });

  it('wires the repository and the queue enqueue into the sweep', async () => {
    await runGenerationJobSweepCron();
    const [deps] = runGenerationJobSweep.mock.calls[0];
    expect(deps.repository).toEqual({ tag: 'repo' });
    expect(deps.enqueue).toBe(enqueueGenerationJob);
  });
});
