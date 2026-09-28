import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  getSettingByName: vi.fn(),
  runDueResearchSchedules: vi.fn(),
  queueResearchRun: vi.fn(),
  resource: { App: { stage: 'dev' }, dataLakeResearchQueue: { url: 'https://sqs.example/research' } } as Record<
    string,
    unknown
  >,
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  adminSettingsRepository: {},
  dataLakeProposalRepository: { name: 'proposals' },
  dataLakeResearchConfigRepository: { name: 'configs' },
  dataLakeResearchRunRepository: { name: 'runs' },
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeResearchService: { runDueResearchSchedules: h.runDueResearchSchedules },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingByName: h.getSettingByName }));
vi.mock('@bike4mind/observability', () => ({ Logger: vi.fn() }));
vi.mock('@server/dataLakes/queueResearchRun', () => ({ queueResearchRun: h.queueResearchRun }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://localhost/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: h.resource }));

import { runResearchScheduleTick } from './dataLakeResearchSchedule';

const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  h.getSettingByName.mockResolvedValue(true);
  h.runDueResearchSchedules.mockResolvedValue({ claimed: 0, started: 0, skipped: 0, failed: 0 });
  h.resource.dataLakeResearchQueue = { url: 'https://sqs.example/research' };
});

describe('runResearchScheduleTick', () => {
  it('fires due schedules against the real repositories and the research queue', async () => {
    await runResearchScheduleTick(logger);

    const [adapters] = h.runDueResearchSchedules.mock.calls[0];
    expect(adapters.db).toEqual({
      dataLakeResearchConfigs: { name: 'configs' },
      dataLakeResearchRuns: { name: 'runs' },
      dataLakeProposals: { name: 'proposals' },
    });
    const run = { id: 'run-1' };
    await adapters.enqueue(run);
    expect(h.queueResearchRun).toHaveBeenCalledWith(run, 'https://sqs.example/research');
  });

  // Claiming nothing is what lets the due configs fire as soon as the flag is back on.
  it('claims nothing while data lakes are switched off', async () => {
    h.getSettingByName.mockResolvedValue(false);
    await expect(runResearchScheduleTick(logger)).resolves.toBeNull();
    expect(h.runDueResearchSchedules).not.toHaveBeenCalled();
  });

  it('claims nothing on a deployment without the research queue', async () => {
    h.resource.dataLakeResearchQueue = undefined;
    await expect(runResearchScheduleTick(logger)).resolves.toBeNull();
    expect(h.runDueResearchSchedules).not.toHaveBeenCalled();
  });
});
