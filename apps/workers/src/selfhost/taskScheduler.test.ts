import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { TaskScheduleHandler, TaskScheduleStatus, type ITaskSchedule } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  update: vi.fn(),
  send: vi.fn(),
  research: vi.fn(),
  user: vi.fn(),
  logger: {
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    updateMetadata: vi.fn(),
  },
}));

vi.mock('@bike4mind/services', async () => ({
  taskSchedulerService: await import('../../../../b4m-core/services/src/taskSchedulerService/process'),
  researchTaskService: { process: mocks.research },
}));
vi.mock('@bike4mind/database', () => ({
  taskScheduleRepository: { claimDueTaskSchedule: mocks.claim, update: mocks.update },
  connectDB: vi.fn(),
  User: { findById: mocks.user },
  adminSettingsRepository: {},
  dataLakeAccessGrantRepository: {},
  dataLakeRepository: {},
  organizationRepository: {},
  researchTaskRepository: {},
  researchDataRepository: {},
  scopedSettingsRepository: {},
  withTransaction: vi.fn(),
  apiKeyRepository: {},
  userRepository: {},
  fabFileRepository: {},
  fileTagRepository: {},
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: class {
    withMetadata() {
      return mocks.logger;
    }
  },
}));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' }, researchEngineQueue: { url: 'queue://research' } } }));
vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://unused/%STAGE%' } }));
vi.mock('@server/utils/sqs', () => ({ sendToQueue: mocks.send }));
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: unknown) => Promise<void>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, mocks.logger),
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: vi.fn() }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch', () => ({ createFirecrawlApp: vi.fn() }));
vi.mock('@bike4mind/auth/apiKeyService', () => ({ getFirecrawlConfig: vi.fn() }));
vi.mock('@bike4mind/services/llm/tools/implementation/webfetch/scrapeWithRetry', () => ({ scrapeWithRetry: vi.fn() }));
vi.mock('@server/jobs/researchTasks', () => ({ researchTaskJobs: {} }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsTextModel: async () => ({ modelId: 'test-model', llm: {} }) },
}));

import { handler } from '@workers/cron/scheduler';
import { registerTaskScheduler } from './taskScheduler';
import { dispatch } from '@server/queueHandlers/researchEngineQueue';

const context = { awsRequestId: 'test-request', functionName: 'test-scheduler', functionVersion: '1' } as Context;
const user = { id: 'user-1' };
let schedule: ITaskSchedule;

function event(body: string): SQSEvent {
  return {
    Records: [
      {
        messageId: 'delivery-1',
        receiptHandle: 'receipt-1',
        body,
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '0',
          SenderId: 'test',
          ApproximateFirstReceiveTimestamp: '0',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: 'test',
        awsRegion: 'test',
      },
    ],
  };
}

const adapters = [
  { name: 'hosted', run: () => handler(undefined as never, context) },
  {
    name: 'self-host',
    run: async () => {
      let tick: (() => Promise<void>) | undefined;
      registerTaskScheduler(
        {
          registerScheduledTask: (_name, _interval, fn) => {
            tick = fn;
          },
        },
        mocks.logger as unknown as Logger
      );
      if (!tick) throw new Error('Scheduler was not registered');
      await tick();
    },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  const now = new Date();
  schedule = {
    id: 'schedule-1',
    handler: TaskScheduleHandler.RESEARCH_TASK_PROCESS,
    payload: { id: 'research-1', userId: 'user-1' },
    status: TaskScheduleStatus.PROCESSING,
    createdAt: now,
    updatedAt: now,
    processDate: now,
    claimedAt: now,
  };
  mocks.claim.mockResolvedValue(null).mockResolvedValueOnce(schedule);
  mocks.user.mockResolvedValue(user);
});

describe.each(adapters)('$name scheduled research adapter', ({ run }) => {
  it('delivers the stored task to the real research consumer process action', async () => {
    const queued: string[] = [];
    mocks.send.mockImplementation(async (_url: string, payload: unknown) => {
      queued.push(JSON.stringify(payload));
    });
    await run();
    expect(schedule.status).toBe(TaskScheduleStatus.COMPLETED);
    expect(queued).toHaveLength(1);
    await dispatch(event(queued[0]), context);
    expect(mocks.research).toHaveBeenCalledWith(user, { id: 'research-1' }, expect.any(Object));
  });

  it('awaits broker acknowledgement before completing the stored task', async () => {
    let acknowledge!: () => void;
    mocks.send.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          acknowledge = resolve;
        })
    );
    let completed = false;
    const running = run().then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());
    expect(schedule.status).toBe(TaskScheduleStatus.PROCESSING);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(completed).toBe(false);
    acknowledge();
    await running;
    expect(schedule.status).toBe(TaskScheduleStatus.COMPLETED);
  });

  it('records a rejected enqueue as failed instead of completed', async () => {
    mocks.send.mockRejectedValue(new Error('broker unavailable'));
    await run();
    expect(schedule.status).toBe(TaskScheduleStatus.FAILED);
    expect(schedule.statusFailedReason).toBe('broker unavailable');
    expect(mocks.update).toHaveBeenCalledWith({
      id: schedule.id,
      status: TaskScheduleStatus.FAILED,
      expireAt: schedule.expireAt,
      statusFailedAt: schedule.statusFailedAt,
      statusFailedReason: 'broker unavailable',
    });
    expect(mocks.research).not.toHaveBeenCalled();
  });
});
