import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

const { step } = vi.hoisted(() => ({ step: vi.fn(async () => 'advanced') }));

vi.mock('@server/generationJobs/wiring', () => ({ getGenerationJobEngine: () => ({ step }) }));
// The real wrapper connects to Mongo; its own contract is covered where it is defined.
vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger:
    (handler: (event: SQSEvent, context: Context, logger: unknown) => Promise<unknown>) =>
    (event: SQSEvent, context: Context) =>
      handler(event, context, { warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { dispatch } from './generationJob';

const event = (body: unknown) => ({ Records: [{ body: JSON.stringify(body) }] }) as unknown as SQSEvent;
const context = { awsRequestId: 'r1' } as Context;

describe('generationJob dispatch', () => {
  beforeEach(() => step.mockClear());

  it('runs exactly one engine step for the message job id', async () => {
    await dispatch(event({ jobId: 'job1' }), context);
    expect(step).toHaveBeenCalledTimes(1);
    expect(step).toHaveBeenCalledWith('job1');
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

  it('lets an engine error propagate so SQS redelivers', async () => {
    step.mockRejectedValueOnce(new Error('db down'));
    await expect(dispatch(event({ jobId: 'job1' }), context)).rejects.toThrow('db down');
  });
});
