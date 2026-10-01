import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  claimCallbackDispatch: vi.fn(),
  releaseCallbackDispatch: vi.fn(),
  sendMessage: vi.fn(),
  // undefined simulates the sst Resource proxy throwing on an unlinked key (see the `sst` mock below).
  queueUrl: 'https://sqs.us-east-2.amazonaws.com/123456789012/generationCallbackQueue' as string | undefined,
  // true simulates a self-hosted deployment that left the optional queue unset (resolves undefined).
  unprovisioned: false,
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: {
    claimCallbackDispatch: h.claimCallbackDispatch,
    releaseCallbackDispatch: h.releaseCallbackDispatch,
  },
}));

vi.mock('@bike4mind/utils', () => ({
  SQSService: class {
    sendMessage(...args: unknown[]) {
      return h.sendMessage(...args);
    }
  },
}));

// The real sst Resource proxy throws when a key is not linked to the running function; mimic
// that here instead of pulling in the real sst runtime.
vi.mock('sst', () => ({
  Resource: new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'generationCallbackQueue') {
          if (h.unprovisioned) return undefined;
          if (h.queueUrl === undefined) {
            throw new Error('Cannot resolve resource "generationCallbackQueue". Is it linked?');
          }
          return { url: h.queueUrl };
        }
        return undefined;
      },
    }
  ),
}));

import { dispatchQuestCallback } from './dispatchQuestCallback';

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe('dispatchQuestCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.queueUrl = 'https://sqs.us-east-2.amazonaws.com/123456789012/generationCallbackQueue';
    h.unprovisioned = false;
  });

  it('does not send when the claim returns null', async () => {
    h.claimCallbackDispatch.mockResolvedValue(null);
    const logger = makeLogger();

    await dispatchQuestCallback('quest-1', logger);

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.releaseCallbackDispatch).not.toHaveBeenCalled();
  });

  it('sends {questId, eventId} to the linked generationCallbackQueue url when the claim succeeds', async () => {
    h.claimCallbackDispatch.mockResolvedValue('quest_quest-1_event');
    h.sendMessage.mockResolvedValue('message-id-1');
    const logger = makeLogger();

    await dispatchQuestCallback('quest-1', logger);

    expect(h.sendMessage).toHaveBeenCalledWith(
      'https://sqs.us-east-2.amazonaws.com/123456789012/generationCallbackQueue',
      { questId: 'quest-1', eventId: 'quest_quest-1_event' }
    );
    expect(h.releaseCallbackDispatch).not.toHaveBeenCalled();
  });

  it('releases the claim and resolves (never throws) when the send fails', async () => {
    h.claimCallbackDispatch.mockResolvedValue('quest_quest-1_event');
    h.sendMessage.mockRejectedValue(new Error('SQS is down'));
    h.releaseCallbackDispatch.mockResolvedValue(undefined);
    const logger = makeLogger();

    await expect(dispatchQuestCallback('quest-1', logger)).resolves.toBeUndefined();

    expect(h.releaseCallbackDispatch).toHaveBeenCalledWith('quest-1', 'quest_quest-1_event');
  });

  it('resolves without releasing when the claim call itself throws', async () => {
    h.claimCallbackDispatch.mockRejectedValue(new Error('Mongo is down'));
    const logger = makeLogger();

    await expect(dispatchQuestCallback('quest-1', logger)).resolves.toBeUndefined();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.releaseCallbackDispatch).not.toHaveBeenCalled();
  });

  it('resolves without claiming when the queue resource is unlinked', async () => {
    h.queueUrl = undefined;
    const logger = makeLogger();

    await expect(dispatchQuestCallback('quest-1', logger)).resolves.toBeUndefined();

    expect(h.claimCallbackDispatch).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('leaves the callback pending, unclaimed, when the queue is not provisioned (self-host)', async () => {
    h.unprovisioned = true;
    const logger = makeLogger();

    await expect(dispatchQuestCallback('quest-1', logger)).resolves.toBeUndefined();

    expect(h.claimCallbackDispatch).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not throw even when releasing the claim also fails', async () => {
    h.claimCallbackDispatch.mockResolvedValue('quest_quest-1_event');
    h.sendMessage.mockRejectedValue(new Error('SQS is down'));
    h.releaseCallbackDispatch.mockRejectedValue(new Error('Mongo is down too'));
    const logger = makeLogger();

    await expect(dispatchQuestCallback('quest-1', logger)).resolves.toBeUndefined();
  });
});
