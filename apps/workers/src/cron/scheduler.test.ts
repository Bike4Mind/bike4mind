import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';

const mocks = vi.hoisted(() => ({ process: vi.fn() }));

vi.mock('@bike4mind/services', () => ({ taskSchedulerService: { process: mocks.process } }));
vi.mock('@bike4mind/database', () => ({ taskScheduleRepository: {}, connectDB: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' }, researchEngineQueue: { url: 'queue' } } }));

const { handler } = await import('./scheduler');
const { TaskScheduleHandler } = await import('@bike4mind/common');

describe('scheduler custom task handler', () => {
  const info = vi.spyOn(Logger.prototype, 'info');
  const consoleLog = vi.spyOn(console, 'log');

  beforeEach(() => {
    vi.clearAllMocks();
    info.mockImplementation(() => undefined);
    consoleLog.mockImplementation(() => undefined);
  });

  it('logs the payload keys only, never its values', async () => {
    mocks.process.mockImplementation(async ({ handlers }) => {
      await handlers[TaskScheduleHandler.CUSTOM_TASK_PROCESS]({ secret: 'hunter2' });
    });

    await handler(undefined as never, { awsRequestId: 'req-1' } as Context);

    expect(info).toHaveBeenCalledWith('Custom scheduled task received; no handler is wired', {
      handler: TaskScheduleHandler.CUSTOM_TASK_PROCESS,
      payloadKeys: ['secret'],
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('hunter2');
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
