import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@bike4mind/observability';

const h = vi.hoisted(() => ({
  claimCallbackDispatch: vi.fn(),
  reclaimStaleCallbackDispatch: vi.fn(),
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
    reclaimStaleCallbackDispatch: h.reclaimStaleCallbackDispatch,
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

import {
  dispatchQuestCallback,
  GENERATION_CALLBACK_STALE_DISPATCH_MS,
  redispatchStaleQuestCallback,
} from './dispatchQuestCallback';
import {
  GENERATION_CALLBACK_MAX_RECEIVE_COUNT,
  GENERATION_CALLBACK_VISIBILITY_TIMEOUT_SEC,
} from '@server/queueHandlers/sqsDelivery';

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

describe('redispatchStaleQuestCallback', () => {
  const criteria = { dispatchedBefore: new Date('2026-01-01T00:00:00Z'), maxRedispatches: 3 };

  beforeEach(() => {
    vi.clearAllMocks();
    h.queueUrl = 'https://sqs.us-east-2.amazonaws.com/123456789012/generationCallbackQueue';
    h.unprovisioned = false;
  });

  it('re-sends under the reclaimed event id, so the receiver can dedupe it', async () => {
    h.reclaimStaleCallbackDispatch.mockResolvedValue('quest_quest-1_event');
    h.sendMessage.mockResolvedValue('message-id-1');

    await redispatchStaleQuestCallback('quest-1', criteria, makeLogger());

    expect(h.reclaimStaleCallbackDispatch).toHaveBeenCalledWith('quest-1', criteria);
    expect(h.claimCallbackDispatch).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledWith(
      'https://sqs.us-east-2.amazonaws.com/123456789012/generationCallbackQueue',
      { questId: 'quest-1', eventId: 'quest_quest-1_event' }
    );
  });

  it('does not send when the reclaim matched nothing (inside the window, or another sweep won)', async () => {
    h.reclaimStaleCallbackDispatch.mockResolvedValue(null);

    await redispatchStaleQuestCallback('quest-1', criteria, makeLogger());

    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('releases the reclaim to pending and resolves when the send fails', async () => {
    h.reclaimStaleCallbackDispatch.mockResolvedValue('quest_quest-1_event');
    h.sendMessage.mockRejectedValue(new Error('SQS is down'));
    h.releaseCallbackDispatch.mockResolvedValue(undefined);

    await expect(redispatchStaleQuestCallback('quest-1', criteria, makeLogger())).resolves.toBeUndefined();

    expect(h.releaseCallbackDispatch).toHaveBeenCalledWith('quest-1', 'quest_quest-1_event');
  });
});

describe('GENERATION_CALLBACK_STALE_DISPATCH_MS', () => {
  // The window is derived from these constants, so pin them to the queue they mirror: a retry or
  // visibility bump in infra alone would otherwise let the sweep race a delivery still retrying.
  const queuesSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../infra/queues.ts'),
    'utf8'
  );
  const queueBlock = queuesSource.match(/new sst\.aws\.Queue\('generationCallbackQueue',\s*\{[\s\S]*?\n\}\);/)?.[0];

  it('finds the generationCallbackQueue declaration in infra/queues.ts', () => {
    expect(queueBlock).toBeDefined();
  });

  it('mirrors the queue retry count and visibility timeout', () => {
    expect(queueBlock).toMatch(new RegExp(`retry: ${GENERATION_CALLBACK_MAX_RECEIVE_COUNT},`));
    expect(queueBlock).toMatch(
      new RegExp(`visibilityTimeout: '${GENERATION_CALLBACK_VISIBILITY_TIMEOUT_SEC / 60} minutes'`)
    );
  });

  it('outlasts every receive the queue can still make', () => {
    const longestDeliveryMs = GENERATION_CALLBACK_MAX_RECEIVE_COUNT * GENERATION_CALLBACK_VISIBILITY_TIMEOUT_SEC * 1000;
    expect(GENERATION_CALLBACK_STALE_DISPATCH_MS).toBeGreaterThan(longestDeliveryMs);
  });
});
