import { describe, it, expect, vi, beforeEach } from 'vitest';
import { insufficientCreditsError, ResearchTaskStatus, TooManyRequestsError } from '@bike4mind/common';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
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
  sendStatusUpdate: vi.fn(),
  questFindById: vi.fn(),
  questUpdateIfUnfinished: vi.fn(),
  questSettle: vi.fn(),
  questRepositoryMock: {} as Record<string, unknown>,
  deepResearchIntoQuest: vi.fn(),
  userRepository: { findById: vi.fn(), incrementCurrentStorage: vi.fn() },
  fabFileRepository: { commitContentRewrite: vi.fn(), findChargeState: vi.fn() },
}));

Object.assign(h.questRepositoryMock, {
  findById: h.questFindById,
  updateIfUnfinished: h.questUpdateIfUnfinished,
  settleIfUnfinished: h.questSettle,
});

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
  questRepository: h.questRepositoryMock,
  Connection: { find: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock('@bike4mind/services', async () => ({
  meterCompletionBackend: (await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services'))
    .meterCompletionBackend,
  researchTaskService: {
    process: h.process,
    processDiscoveredLinks: h.processDiscoveredLinks,
    downloadRelevantLinks: h.downloadRelevantLinks,
    deepResearchIntoQuest: h.deepResearchIntoQuest,
  },
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({
  createCompletionMeter: () => h.meter,
  assertOwnerCanAfford: h.afford,
}));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', () => ({ createFirecrawlApp: vi.fn() }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch/scrapeWithRetry', () => ({ scrapeWithRetry: vi.fn() }));
vi.mock('@bike4mind/auth/apiKeyService', () => ({ getFirecrawlConfig: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@server/jobs/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@server/utils/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsTextModel: h.getOperationsTextModel },
}));

vi.mock('@bike4mind/services/llm/StatusManager', () => ({
  StatusManager: vi.fn(function () {
    return { sendStatusUpdate: h.sendStatusUpdate };
  }),
}));
vi.mock('@bike4mind/utils', async () => ({
  ...(await vi.importActual<typeof import('@bike4mind/utils')>('@bike4mind/utils')),
  ClientMessageSender: vi.fn(),
}));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://x' } } }));

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

  it('fails a discovered-links run on the free-tier daily cap without rethrowing', async () => {
    const message = 'Daily free limit reached';
    h.meter.mockRejectedValue(
      new TooManyRequestsError(message, { errorCode: 'daily_free_limit_reached', retryAfter: 3600 })
    );

    await expect(dispatch(makeEvent('processDiscoveredLinks'), {} as never, logger as never)).resolves.toBeUndefined();

    expect(h.complete).not.toHaveBeenCalled();
    expect(h.taskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rt1', status: ResearchTaskStatus.FAILED, statusFailedMessage: message })
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

const researchEvent = (payload: Record<string, unknown>) =>
  ({ Records: [{ body: JSON.stringify({ action: 'deepResearchIntoQuest', payload }) }] }) as never;
const job = { questId: 'q1', sessionId: 's1', userId: 'u1', topic: 'Rare earth magnet supply' };

describe('deepResearchIntoQuest action', () => {
  const stored = {
    id: 'q1',
    sessionId: 's1',
    status: 'running',
    prompt: 'Research rare earths',
    type: 'message',
    timestamp: new Date(1),
    promptMeta: { x: 1 },
  };
  const refusal = () =>
    Object.assign(new Error('Not enough credits'), { additionalInfo: { errorCode: 'insufficient_credits' } });
  const patch = { status: 'done', type: 'error', reply: 'Not enough credits', replies: ['Not enough credits'] };

  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: 'u1' });
    h.questFindById.mockResolvedValue(stored);
    h.getOperationsTextModel.mockResolvedValue({ modelId: 'ops', llm: { complete: h.complete }, modelInfo: {} });
  });

  it('runs research for the quest on the metered operations model', async () => {
    await dispatch(researchEvent(job), {} as never, logger as never);
    expect(h.afford).toHaveBeenCalled();
    expect(h.deepResearchIntoQuest).toHaveBeenCalledTimes(1);
    const [params, adapters] = h.deepResearchIntoQuest.mock.calls[0];
    expect(params).toStrictEqual({ questId: 'q1', topic: 'Rare earth magnet supply' });
    expect(adapters.quests).toBe(h.questRepositoryMock);
    expect(adapters.toolContext).toMatchObject({
      userId: 'u1',
      sessionId: 's1',
      questId: 'q1',
      authOrigin: 'internal',
    });
    expect(adapters.llm.complete).toEqual(expect.any(Function));
    expect(adapters.llm.complete).not.toBe(h.complete);
  });

  it('pushes progress with the stored turn text under the partial', async () => {
    await dispatch(researchEvent(job), {} as never, logger as never);
    const { push } = h.deepResearchIntoQuest.mock.calls[0][1];
    await push({ id: 'q1', sessionId: 's1', status: 'running', deepResearchState: { findings: [] } });
    expect(h.sendStatusUpdate).toHaveBeenCalledWith(
      {
        id: 'q1',
        sessionId: 's1',
        prompt: 'Research rare earths',
        type: 'message',
        timestamp: stored.timestamp,
        promptMeta: { x: 1 },
        status: 'running',
        deepResearchState: { findings: [] },
      },
      null
    );
  });

  it('does not push when the quest is gone', async () => {
    h.questFindById.mockResolvedValue(null);
    await dispatch(researchEvent(job), {} as never, logger as never);
    const { push } = h.deepResearchIntoQuest.mock.calls[0][1];
    await push({ id: 'q1', sessionId: 's1', status: 'running' });
    expect(h.sendStatusUpdate).not.toHaveBeenCalled();
  });

  it('settles and pushes the refusal when the owner cannot pay, without rethrowing', async () => {
    h.questSettle.mockResolvedValue(true);
    h.afford.mockRejectedValueOnce(refusal());
    await expect(dispatch(researchEvent(job), {} as never, logger as never)).resolves.toBeUndefined();
    expect(h.deepResearchIntoQuest).not.toHaveBeenCalled();
    expect(h.questSettle).toHaveBeenCalledWith('q1', patch);
    expect(h.sendStatusUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'q1', sessionId: 's1', prompt: 'Research rare earths', ...patch }),
      null
    );
  });

  it('does not push the refusal when the quest was already settled', async () => {
    h.questSettle.mockResolvedValue(false);
    h.afford.mockRejectedValueOnce(refusal());
    await dispatch(researchEvent(job), {} as never, logger as never);
    expect(h.questSettle).toHaveBeenCalled();
    expect(h.sendStatusUpdate).not.toHaveBeenCalled();
  });

  it('rethrows a non-refusal billing error so the message is redelivered', async () => {
    h.afford.mockRejectedValueOnce(new Error('db down'));
    await expect(dispatch(researchEvent(job), {} as never, logger as never)).rejects.toThrow('db down');
    expect(h.deepResearchIntoQuest).not.toHaveBeenCalled();
    expect(h.questSettle).not.toHaveBeenCalled();
  });

  it('rejects a topic that is empty or longer than 2000 characters', async () => {
    await expect(dispatch(researchEvent({ ...job, topic: '' }), {} as never, logger as never)).rejects.toThrow();
    await expect(
      dispatch(researchEvent({ ...job, topic: 'x'.repeat(2001) }), {} as never, logger as never)
    ).rejects.toThrow();
    expect(h.deepResearchIntoQuest).not.toHaveBeenCalled();
  });
});
