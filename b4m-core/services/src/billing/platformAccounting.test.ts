import { describe, expect, it, vi } from 'vitest';
import {
  ModelBackend,
  PlatformAccountingConflictError,
  type IPlatformAttempt,
  type ModelInfo,
} from '@bike4mind/common';
import {
  createPlatformAttribution,
  pricePlatformUsage,
  PlatformAccounting,
  PlatformAccountingPendingError,
} from './platformAccounting';

const at = new Date('2026-10-31T23:59:59Z');
const attribution = createPlatformAttribution(
  { environment: 'test' },
  { logicalJobId: 'job-1', executionId: 'execution-1' }
);
const attempt: IPlatformAttempt = {
  attribution,
  providerCallId: 'call-1',
  provider: 'bedrock',
  model: 'test-model',
  state: 'dispatched',
  leaseExpiresAt: new Date('2026-11-01T00:02:00Z'),
  dispatchedAt: at,
  createdAt: at,
  updatedAt: at,
};
const model: ModelInfo = {
  id: 'test-model',
  name: 'Test',
  type: 'text',
  backend: ModelBackend.Bedrock,
  contextWindow: 100000,
  pricing: { 100000: { input: 1e-6, output: 2e-6, cache_read: 0.1e-6, cache_write: 1.25e-6 } },
  priceSource: 'catalog',
  priceRowId: 'test-price',
};
const params = {
  attempt,
  model,
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 20,
    cacheWrite1hInputTokens: 5,
  },
  outcome: 'error' as const,
  completedAt: new Date('2026-11-01T00:00:01Z'),
  now: new Date('2026-11-01T00:00:02Z'),
};

describe('platform usage pricing', () => {
  it('uses existing single-attempt pricing and stamps disjoint provider counts and cache rates', () => {
    const event = pricePlatformUsage(params);
    expect(event).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      providerInputTokens: 100,
      providerOutputTokens: 50,
      creditsCharged: 0,
      source: 'system',
      status: 'error',
      priceSource: 'catalog',
      priceRowId: 'test-price',
      cachedInputTokens: 10,
      cacheWriteTokens: 20,
      cacheWrite1hTokens: 5,
      timestampSource: 'dispatch',
      usageOccurredAt: at,
    });
    expect(event.costUsd).toBeCloseTo(229.75e-6, 12);
    expect(event).not.toHaveProperty('userId');
    expect(event).not.toHaveProperty('ownerId');
  });

  it('keeps provider occurrence time separate from late persistence', () => {
    const providerOccurredAt = new Date('2026-10-31T23:59:58Z');
    const event = pricePlatformUsage({ ...params, providerOccurredAt });
    expect(event).toMatchObject({
      timestampSource: 'provider',
      usageOccurredAt: providerOccurredAt,
      recordedAt: params.now,
    });
  });

  it('rejects missing counts, invalid caches, model mismatch and absent price provenance', () => {
    for (const changed of [
      { usage: { inputTokens: undefined, outputTokens: 0 } },
      { usage: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: -1 } },
      { usage: { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 1, cacheWrite1hInputTokens: 2 } },
      { model: { ...model, id: 'another-model' } },
      { model: { ...model, backend: ModelBackend.OpenAI } },
      { model: { ...model, pricing: undefined } },
      { model: { ...model, priceRowId: undefined } },
    ]) {
      expect(() => pricePlatformUsage({ ...params, ...changed } as Parameters<typeof pricePlatformUsage>[0])).toThrow();
    }
  });

  it('rejects malformed optional cache counts before pricing can discard or clamp them', () => {
    for (const key of ['cacheReadInputTokens', 'cacheCreationInputTokens', 'cacheWrite1hInputTokens'] as const) {
      for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => pricePlatformUsage({ ...params, usage: { ...params.usage, [key]: value } })).toThrow();
      }
    }
    expect(() =>
      pricePlatformUsage({ ...params, usage: { inputTokens: 100, outputTokens: 50, cacheWrite1hInputTokens: 1 } })
    ).toThrow();
  });

  it('constructs only registered operation metadata from explicit configuration and execution', () => {
    expect(attribution).toEqual({
      kind: 'platform_operation',
      operation: 'sre_diagnosis',
      environment: 'test',
      logicalJobId: 'job-1',
      executionId: 'execution-1',
    });
    expect(() =>
      createPlatformAttribution({ environment: 'unknown' as 'test' }, { logicalJobId: 'job', executionId: 'exec' })
    ).toThrow();
    expect(() =>
      createPlatformAttribution({ environment: 'test' }, { logicalJobId: '', executionId: 'exec' })
    ).toThrow();
  });
});

describe('platform accounting failure propagation', () => {
  it('does not report settlement success when staging fails', async () => {
    const attempts = { stageUsage: vi.fn().mockRejectedValue(new Error('storage unavailable')) };
    const record = vi.fn();
    const service = new PlatformAccounting(attempts as never, { recordPlatform: record } as never);
    await expect(service.settle('call-1', pricePlatformUsage(params))).rejects.toBeInstanceOf(
      PlatformAccountingPendingError
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('keeps canonical persistence failure typed for later recovery and never acknowledges a receipt', async () => {
    const fact = pricePlatformUsage(params);
    const markRecorded = vi.fn();
    const attempts = { stageUsage: vi.fn().mockResolvedValue({ ...attempt, usage: fact }), markRecorded };
    const service = new PlatformAccounting(
      attempts as never,
      { recordPlatform: vi.fn().mockRejectedValue(new Error('ledger unavailable')) } as never
    );
    await expect(service.settle('call-1', fact)).rejects.toMatchObject({
      name: 'PlatformAccountingPendingError',
      providerCallId: 'call-1',
    });
    expect(markRecorded).not.toHaveBeenCalled();
  });
});

describe('bounded platform recovery', () => {
  it('throws a page-fetch failure without mutating attempts or losing the input continuation', async () => {
    const recoverable = vi.fn().mockRejectedValue(new Error('page unavailable'));
    const markUnresolved = vi.fn();
    const recordPlatform = vi.fn();
    const service = new PlatformAccounting({ recoverable, markUnresolved } as never, { recordPlatform } as never);
    const page = { now: at, limit: 2, afterProviderCallId: 'previous-page' };
    await expect(service.recover(page)).rejects.toThrow('page unavailable');
    expect(recoverable).toHaveBeenCalledExactlyOnceWith(page);
    expect(page.afterProviderCallId).toBe('previous-page');
    expect(markUnresolved).not.toHaveBeenCalled();
    expect(recordPlatform).not.toHaveBeenCalled();
  });

  it('rejects invalid page bounds before fetching or writing', async () => {
    const recoverable = vi.fn();
    const service = new PlatformAccounting({ recoverable } as never, {} as never);
    for (const limit of [0, -1, 0.5, NaN, Infinity, 1001]) {
      await expect(service.recover({ now: at, limit })).rejects.toThrow('Invalid platform recovery page');
    }
    await expect(service.recover({ now: new Date(NaN), limit: 1 })).rejects.toThrow('Invalid platform recovery page');
    expect(recoverable).not.toHaveBeenCalled();
  });

  it('rejects an oversized repository page without processing any attempt', async () => {
    const recoverable = vi.fn().mockResolvedValue({ attempts: [attempt, attempt] });
    const get = vi.fn();
    const recordPlatform = vi.fn();
    const service = new PlatformAccounting({ recoverable, get } as never, { recordPlatform } as never);
    await expect(service.recover({ now: at, limit: 1 })).rejects.toThrow('exceeds its limit');
    expect(get).not.toHaveBeenCalled();
    expect(recordPlatform).not.toHaveBeenCalled();
  });

  it('bounds the failure list to its page and returns only original call identities and safe codes', async () => {
    const id = 'a'.repeat(128);
    const fact = { ...pricePlatformUsage(params), providerCallId: id };
    const recoverable = vi
      .fn()
      .mockResolvedValue({ attempts: [{ ...attempt, providerCallId: id, usage: fact }], nextCursor: id });
    const stageUsage = vi.fn().mockRejectedValue(new PlatformAccountingConflictError());
    const recordPlatform = vi.fn();
    const service = new PlatformAccounting({ recoverable, stageUsage } as never, { recordPlatform } as never);
    expect(await service.recover({ now: at, limit: 1 })).toEqual({
      recorded: 0,
      unresolved: 0,
      failed: [{ providerCallId: id, code: 'conflict' }],
      nextCursor: id,
    });
    expect(recordPlatform).not.toHaveBeenCalled();
  });

  it('never forwards error-controlled identifiers or private error details into recovery results', async () => {
    const fact = pricePlatformUsage(params);
    const recoverable = vi.fn().mockResolvedValue({ attempts: [{ ...attempt, usage: fact }] });
    const stageUsage = vi
      .fn()
      .mockRejectedValue(
        new PlatformAccountingPendingError('private-error-identity', { cause: new Error('private provider payload') })
      );
    const service = new PlatformAccounting({ recoverable, stageUsage } as never, {} as never);
    const result = await service.recover({ now: at, limit: 1 });
    expect(result).toEqual({
      recorded: 0,
      unresolved: 0,
      failed: [{ providerCallId: attempt.providerCallId, code: 'persistence_pending' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|cause|message|stack/);
  });

  it('does not count a concurrent live or usage-known attempt as durably unresolved', async () => {
    const recoverable = vi.fn().mockResolvedValue({ attempts: [attempt] });
    const markUnresolved = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue({ ...attempt, state: 'usage_known' });
    const findPlatformCall = vi.fn().mockResolvedValue(null);
    const service = new PlatformAccounting(
      { recoverable, markUnresolved, get } as never,
      { findPlatformCall } as never
    );
    expect(await service.recover({ now: at, limit: 1 })).toEqual({
      recorded: 0,
      unresolved: 0,
      failed: [{ providerCallId: attempt.providerCallId, code: 'persistence_pending' }],
    });
    expect(markUnresolved).toHaveBeenCalledExactlyOnceWith(attempt.providerCallId, 'expired_intent', at);
  });
});
