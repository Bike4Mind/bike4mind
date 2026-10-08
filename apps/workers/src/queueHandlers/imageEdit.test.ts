import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  process: vi.fn(),
  dispatchQuestCallback: vi.fn(),
}));

vi.mock('@server/imageGenerations/imageEdit', () => ({
  getImageEdit: () => ({ process: h.process }),
}));

vi.mock('@server/generationCallback/dispatchQuestCallback', () => ({
  dispatchQuestCallback: h.dispatchQuestCallback,
}));

import { dispatch } from './imageEdit';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const context = { awsRequestId: 'req-1' } as Context;
const BODY = { questId: 'quest-1', prompt: 'a red bicycle' };
const event = { Records: [{ body: JSON.stringify(BODY) }] } as unknown as SQSEvent;

// dispatchWithLogger is mocked to a passthrough, so dispatch takes the logger as a third argument.
const run = () => (dispatch as unknown as (e: SQSEvent, c: Context, l: never) => Promise<void>)(event, context, logger);

describe('imageEdit dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('processes the parsed SQS body and fires the quest callback', async () => {
    h.process.mockResolvedValue(undefined);

    await run();

    expect(h.process).toHaveBeenCalledWith({ body: BODY, logger });
    expect(h.dispatchQuestCallback).toHaveBeenCalledWith('quest-1', logger);
    expect(h.dispatchQuestCallback).toHaveBeenCalledTimes(1);
    expect(h.process.mock.invocationCallOrder[0]).toBeLessThan(h.dispatchQuestCallback.mock.invocationCallOrder[0]);
  });

  it('still fires the quest callback when process throws, and rethrows', async () => {
    const failure = new Error('provider down');
    h.process.mockRejectedValue(failure);

    await expect(run()).rejects.toBe(failure);

    expect(h.dispatchQuestCallback).toHaveBeenCalledWith('quest-1', logger);
    expect(h.dispatchQuestCallback).toHaveBeenCalledTimes(1);
    expect(h.process.mock.invocationCallOrder[0]).toBeLessThan(h.dispatchQuestCallback.mock.invocationCallOrder[0]);
  });
});
