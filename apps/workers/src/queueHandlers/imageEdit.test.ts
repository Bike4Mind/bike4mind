import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  process: vi.fn(),
  dispatchQuestCallback: vi.fn(),
  publishImageQuestReadyPush: vi.fn(),
}));

vi.mock('@server/imageGenerations/imageEdit', () => ({
  getImageEdit: () => ({ process: h.process }),
}));

vi.mock('@bike4mind/database', () => ({ Connection: {}, questRepository: {} }));
vi.mock('@server/utils/pushNotifications', () => ({ publishPushNotification: vi.fn(), sessionDeepLink: vi.fn() }));
vi.mock('./generationPush', () => ({ publishImageQuestReadyPush: h.publishImageQuestReadyPush }));

vi.mock('@bike4mind/server-utils/generationCallback/dispatchQuestCallback', () => ({
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
    vi.resetAllMocks();
  });

  it('fires the quest callback only after process settles', async () => {
    let settle!: () => void;
    h.process.mockImplementation(() => new Promise<void>(resolve => (settle = resolve)));

    const running = run();
    expect(h.process).toHaveBeenCalledWith({ body: BODY, logger });
    expect(h.dispatchQuestCallback).not.toHaveBeenCalled();

    settle();
    await running;

    expect(h.dispatchQuestCallback).toHaveBeenCalledWith('quest-1', logger);
    expect(h.dispatchQuestCallback).toHaveBeenCalledTimes(1);
  });

  it('does not return until the quest callback settles', async () => {
    h.process.mockResolvedValue(undefined);
    let settleCallback!: () => void;
    h.dispatchQuestCallback.mockImplementation(() => new Promise<void>(resolve => (settleCallback = resolve)));

    let returned = false;
    const running = run().then(() => (returned = true));
    await vi.waitFor(() => expect(h.dispatchQuestCallback).toHaveBeenCalled());
    expect(returned).toBe(false);

    settleCallback();
    await running;
    expect(returned).toBe(true);
  });

  it('fires the quest callback only after process rejects, then rethrows', async () => {
    const failure = new Error('provider down');
    let fail!: () => void;
    h.process.mockImplementation(() => new Promise<void>((_, reject) => (fail = () => reject(failure))));

    const running = run();
    expect(h.dispatchQuestCallback).not.toHaveBeenCalled();

    fail();
    await expect(running).rejects.toBe(failure);

    expect(h.dispatchQuestCallback).toHaveBeenCalledWith('quest-1', logger);
    expect(h.dispatchQuestCallback).toHaveBeenCalledTimes(1);
    expect(h.publishImageQuestReadyPush).not.toHaveBeenCalled();
  });

  it('publishes the generation_ready push for the settled quest after the callback', async () => {
    const calls: string[] = [];
    h.process.mockResolvedValue(undefined);
    h.dispatchQuestCallback.mockImplementation(async () => void calls.push('callback'));
    h.publishImageQuestReadyPush.mockImplementation(async () => void calls.push('push'));

    await run();

    expect(calls).toEqual(['callback', 'push']);
    expect(h.publishImageQuestReadyPush).toHaveBeenCalledWith(BODY, 'edit', expect.any(Object), logger);
  });
});
