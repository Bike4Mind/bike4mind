import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchTaskStatus } from '@bike4mind/common';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  userFindById: vi.fn(),
  taskFindById: vi.fn(),
  taskUpdate: vi.fn(),
  getOperationsTextModel: vi.fn(),
}));

// Every export the module reads at import time, declared because this mock replaces the whole module.
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  organizationRepository: {},
  researchTaskRepository: { findById: h.taskFindById, update: h.taskUpdate },
  researchDataRepository: {},
  scopedSettingsRepository: {},
  withTransaction: vi.fn(),
  apiKeyRepository: {},
  userRepository: {},
  User: { findById: h.userFindById },
  fabFileRepository: {},
  taskScheduleRepository: {},
  fileTagRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ researchTaskService: { process: vi.fn() } }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', () => ({ createFirecrawlApp: vi.fn() }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch/scrapeWithRetry', () => ({ scrapeWithRetry: vi.fn() }));
vi.mock('@bike4mind/auth/apiKeyService', () => ({ getFirecrawlConfig: vi.fn() }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/jobs/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsTextModel: h.getOperationsTextModel },
}));

import { dispatch } from './researchEngineQueue';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
} as never;

const makeEvent = (action: string) =>
  ({ Records: [{ body: JSON.stringify({ action, payload: { id: 'rt1', userId: 'u1' } }) }] }) as never;

describe('researchEngineQueue process - failure reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getOperationsTextModel.mockResolvedValue({ modelId: 'm', llm: {} });
    h.userFindById.mockRejectedValue(new Error('boom'));
    h.taskFindById.mockResolvedValue({ id: 'rt1', status: ResearchTaskStatus.PROCESSING });
    h.taskUpdate.mockResolvedValue(undefined);
  });

  it('writes exactly { id, status, statusFailedMessage, statusFailedAt } and swallows the error at the outer catch', async () => {
    await expect(dispatch(makeEvent('process'), {} as never, logger)).resolves.toBeUndefined();

    expect(h.taskUpdate).toHaveBeenCalledTimes(1);
    expect(h.taskUpdate.mock.calls[0][0]).toStrictEqual({
      id: 'rt1',
      status: ResearchTaskStatus.FAILED,
      statusFailedMessage: 'boom',
      statusFailedAt: expect.any(Date),
    });
    expect(logger.warn).toHaveBeenCalledWith('Error processing research task', { error: expect.any(Error) });
  });

  it('does not write when the task no longer exists', async () => {
    h.taskFindById.mockResolvedValue(null);

    await dispatch(makeEvent('process'), {} as never, logger);

    expect(h.taskUpdate).not.toHaveBeenCalled();
  });
});
