import { describe, expect, it, vi } from 'vitest';
import { ModelBackend, type IPlatformAttempt, type ModelInfo } from '@bike4mind/common';
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
