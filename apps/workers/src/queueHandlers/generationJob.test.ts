import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

const { step, publishGenerationJobReadyPush } = vi.hoisted(() => ({
  step: vi.fn(async (_jobId: string, _options?: { remainingMs?: number }) => 'advanced'),
  publishGenerationJobReadyPush: vi.fn(async () => undefined),
}));

vi.mock('@server/generationJobs/wiring', () => ({ getGenerationJobEngine: () => ({ step }) }));
vi.mock('@bike4mind/database', () => ({ generationJobRepository: {} }));
vi.mock('@server/utils/pushNotifications', () => ({
  appRootDeepLink: vi.fn(),
  publishPushNotification: vi.fn(),
  sessionDeepLink: vi.fn(),
}));
vi.mock('./generationPush', () => ({ publishGenerationJobReadyPush }));
// The real wrapper connects to Mongo; its own contract is covered where it is defined.
vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: unknown) => Promise<unknown>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, { warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { dispatch } from './generationJob';

const event = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as unknown as SQSEvent;
const context = { awsRequestId: 'r1' } as Context;

describe('generationJob dispatch', () => {
  beforeEach(() => {
    step.mockClear();
    publishGenerationJobReadyPush.mockClear();
  });

  it('runs exactly one engine step for the message job id', async () => {
    await dispatch(event({ jobId: 'job1' }), context);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith('job1', { remainingMs: undefined });
  });

  it('passes the invocation remaining time to the engine', async () => {
    const lambdaContext = { awsRequestId: 'r2', getRemainingTimeInMillis: () => 120_000 } as unknown as Context;
    await dispatch(event({ jobId: 'job1' }), lambdaContext);
    expect(step).toHaveBeenCalledWith('job1', { remainingMs: 120_000 });
  });

  it('drops a malformed message instead of retrying it forever', async () => {
    await expect(dispatch(event({ nope: true }), context)).resolves.toBeUndefined();
    expect(step).not.toHaveBeenCalled();
  });

  it('drops a non-JSON body instead of throwing', async () => {
    const raw = { Records: [{ body: 'not json {' }] } as unknown as SQSEvent;
    await expect(dispatch(raw, context)).resolves.toBeUndefined();
    expect(step).not.toHaveBeenCalled();
  });

  it('publishes the generation_ready push only for the step that reports the job terminal', async () => {
    await dispatch(event({ jobId: 'job1' }), context);
    expect(publishGenerationJobReadyPush).not.toHaveBeenCalled();

    step.mockResolvedValueOnce('terminal');
    await dispatch(event({ jobId: 'job1' }), context);
    expect(publishGenerationJobReadyPush).toHaveBeenCalledExactlyOnceWith(
      'job1',
      expect.any(Object),
      expect.anything()
    );
  });

  it('lets an engine error propagate so SQS redelivers', async () => {
    step.mockRejectedValueOnce(new Error('db down'));
    await expect(dispatch(event({ jobId: 'job1' }), context)).rejects.toThrow('db down');
  });
});
