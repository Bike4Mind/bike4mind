import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insufficientCreditsError, ResearchTaskStatus } from '@bike4mind/common';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  userFindById: vi.fn(),
  taskFindById: vi.fn(),
  taskUpdate: vi.fn(),
  getOperationsTextModel: vi.fn(),
  process: vi.fn(),
  processDiscoveredLinks: vi.fn(),
  downloadRelevantLinks: vi.fn(),
  meter: vi.fn(),
  afford: vi.fn(),
  complete: vi.fn(),
  userRepository: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
  fabFileRepository: { commitContentRewrite: vi.fn(), findChargeState: vi.fn() },
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
  userRepository: h.userRepository,
  User: { findById: h.userFindById },
  fabFileRepository: h.fabFileRepository,
  taskScheduleRepository: {},
  fileTagRepository: {},
}));
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services'))
    .meterCompletionBackend,
  researchTaskService: {
    process: h.process,
    processDiscoveredLinks: h.processDiscoveredLinks,
    downloadRelevantLinks: h.downloadRelevantLinks,
  },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createCompletionMeter: () => h.meter,
  assertOwnerCanAfford: h.afford,
}));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', () => ({ createFirecrawlApp: vi.fn() }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch/scrapeWithRetry', () => ({ scrapeWithRetry: vi.fn() }));
vi.mock('@bike4mind/auth/apiKeyService', () => ({ getFirecrawlConfig: vi.fn() }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/jobs/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsTextModel: h.getOperationsTextModel },
}));

import { dispatch } from './researchEngineQueue';
import { commitContentRewrite } from '../../../../b4m-core/services/src/fabFileService/rewriteStorage';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  updateMetadata: vi.fn(),
};

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
    await expect(dispatch(makeEvent('process'), {} as never, logger as never)).resolves.toBeUndefined();

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

    await dispatch(makeEvent('process'), {} as never, logger as never);

    expect(h.taskUpdate).not.toHaveBeenCalled();
  });
});

describe('researchEngineQueue metering', () => {
  const runLlm = async (_a: unknown, _b: unknown, deps: { llm: { complete: (...a: unknown[]) => unknown } }) => {
    await deps.llm.complete('m', [{ role: 'user', content: 'q' }], {}, async () => {});
  };

  beforeEach(() => {
    vi.clearAllMocks();
    h.getOperationsTextModel.mockResolvedValue({ modelId: 'm', llm: { complete: h.complete }, modelInfo: { id: 'm' } });
    h.userFindById.mockResolvedValue({ id: 'u1' });
    h.taskFindById.mockResolvedValue({ id: 'rt1', status: ResearchTaskStatus.PROCESSING });
    h.complete.mockImplementation(async (_m, _msgs, _o, cb) => cb(['ok'], { inputTokens: 10, outputTokens: 5 }));
    h.process.mockImplementation(runLlm);
    h.processDiscoveredLinks.mockImplementation((a: unknown, deps: Parameters<typeof runLlm>[2]) => runLlm(a, a, deps));
  });

  it('settles each research LLM call against the task owner', async () => {
    const settle = vi.fn().mockResolvedValue(1);
    h.meter.mockResolvedValue({ settle, refund: vi.fn() });

    await dispatch(makeEvent('process'), {} as never, logger as never);

    expect(h.complete).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });
  });

  it('fails a task for an owner out of credits before the service scrapes anything', async () => {
    h.afford.mockRejectedValueOnce(insufficientCreditsError('Not enough credits'));

    await dispatch(makeEvent('process'), {} as never, logger as never);

    expect(h.process).not.toHaveBeenCalled();
    expect(h.taskUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: ResearchTaskStatus.FAILED }));
  });

  it('fails a discovered-links run for an owner out of credits without calling the provider or rethrowing', async () => {
    h.meter.mockRejectedValue(insufficientCreditsError('Not enough credits'));

    await expect(dispatch(makeEvent('processDiscoveredLinks'), {} as never, logger as never)).resolves.toBeUndefined();

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'rt1',
        status: ResearchTaskStatus.FAILED,
        statusFailedMessage: 'Not enough credits',
      })
    );
  });
});

describe('researchEngineQueue downloadRelevantLinks - storage adapters', () => {
  beforeEach(() => vi.clearAllMocks());

  // A re-crawl rewrite commits through these adapters; a hand-built `users` once lacked
  // incrementCurrentStorage, so the commit threw after the upload and the counter drifted.
  it('gives the re-crawl commit a users adapter that can move the storage counter', async () => {
    h.fabFileRepository.commitContentRewrite.mockResolvedValue({
      userId: 'u1',
      fileSize: 100,
      storageChargedAt: new Date(),
    });
    h.downloadRelevantLinks.mockImplementation(async (_params, adapters) => {
      await commitContentRewrite({ fabFileId: 'f1', newSize: 250 }, adapters.db);
    });

    await dispatch(makeEvent('downloadRelevantLinks'), {} as never, logger as never);

    expect(h.downloadRelevantLinks).toHaveBeenCalledTimes(1);
    expect(h.userRepository.incrementCurrentStorage).toHaveBeenCalledWith('u1', 150);
  });
});
