import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AttributedUsageEvent,
  PlatformUsageEvent,
  UsageEvent as UsageEventValidator,
  PlatformAccountingConflictError,
  type IPlatformAttemptRegistration,
  type IPlatformUsageEventInput,
} from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { UsageEvent, usageEventRepository } from './UsageEventModel';
import { PlatformAttempt, platformAttemptRepository } from './PlatformAttemptModel';
import {
  PlatformAccounting,
  PlatformAccountingPendingError,
} from '../../../../../b4m-core/services/src/billing/platformAccounting';

let mongo: MongoMemoryServer;
const at = new Date('2026-10-31T23:59:59Z');
const attribution = {
  kind: 'platform_operation' as const,
  operation: 'sre_diagnosis' as const,
  environment: 'test' as const,
  logicalJobId: 'job-1',
  executionId: 'execution-1',
};
const registration = (providerCallId = 'call-1'): IPlatformAttemptRegistration => ({
  providerCallId,
  attribution,
  provider: 'test-provider',
  model: 'test-model',
  leaseExpiresAt: new Date('2026-11-01T00:02:00Z'),
});
const fact = (providerCallId = 'call-1'): IPlatformUsageEventInput => ({
  providerCallId,
  attribution,
  requestId: attribution.executionId,
  source: 'system',
  feature: 'operations',
  keySource: 'platform',
  provider: 'test-provider',
  model: 'test-model',
  inputTokens: 0,
  outputTokens: 0,
  providerInputTokens: 100,
  providerOutputTokens: 50,
  cachedInputTokens: 10,
  cacheWriteTokens: 5,
  costUsd: 0.0002175,
  creditsCharged: 0,
  settledBasis: 'provider',
  priceSource: 'literal',
  rates: { tierKey: 0, input: 0.000001, output: 0.000002, cacheRead: 0.0000005, cacheWrite: 0.0000025 },
  usageOccurredAt: at,
  timestampSource: 'dispatch',
  dispatchedAt: at,
  completedAt: new Date('2026-11-01T00:00:01Z'),
  recordedAt: new Date('2026-11-01T00:00:02Z'),
  status: 'ok',
});
const accounting = () => new PlatformAccounting(platformAttemptRepository, usageEventRepository);
const dispatched = async (id = 'call-1') => {
  await platformAttemptRepository.register(registration(id));
  expect(await platformAttemptRepository.claimDispatch(id, at)).toBe(true);
};

beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri());
  await Promise.all([UsageEvent.syncIndexes(), PlatformAttempt.syncIndexes()]);
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([UsageEvent.deleteMany({}), PlatformAttempt.deleteMany({})]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('platform accounting prerequisites', () => {
  it('validates a distinct actorless platform variant and keeps legacy ownership mandatory', () => {
    const input = { ...fact(), createdAt: new Date(), updatedAt: new Date() };
    expect(UsageEventValidator.parse(input).attribution?.kind).toBe('platform_operation');
    for (const changed of [
      { userId: 'invented' },
      { ownerId: 'invented' },
      { ownerType: 'User' },
      { creditsCharged: 1 },
      { source: 'web' },
      { attribution: { ...attribution, operation: 'unknown' } },
      { providerInputTokens: undefined },
      { providerOutputTokens: -1 },
      { costUsd: NaN },
      { costUsd: 0 },
      { fundingBreakdown: { granted: 0, purchased: 0, subscription: 0, unknown: 0 } },
      { rates: { ...input.rates, input: -1 } },
      { inputTokens: 100 },
      { arbitraryPayload: 'secret' },
      { usageOccurredAt: new Date('2026-10-31T23:59:58Z') },
    ])
      expect(UsageEventValidator.safeParse({ ...input, ...changed }).success).toBe(false);
    expect(AttributedUsageEvent.safeParse(input).success).toBe(false);
    expect(UsageEventValidator.safeParse({ ...input, attribution: undefined }).success).toBe(false);
    expect(
      PlatformUsageEvent.safeParse({
        ...input,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      }).success
    ).toBe(true);
  });

  it('enforces hybrid validation at the actual Mongo document boundary', async () => {
    await expect(
      UsageEvent.create({ ...fact(), userId: 'invented', ownerId: 'invented', ownerType: 'User' })
    ).rejects.toThrow();
    await expect(UsageEvent.create({ ...fact(), creditsCharged: 1 })).rejects.toThrow();
    await expect(UsageEvent.create({ ...fact(), providerInputTokens: undefined })).rejects.toThrow();
    expect(await UsageEvent.countDocuments()).toBe(0);
  });

  it('enforces the real partial unique index without constraining legacy request IDs', async () => {
    const indexes = await UsageEvent.collection.indexes();
    expect(indexes.find(index => index.key.providerCallId === 1)).toMatchObject({
      unique: true,
      partialFilterExpression: { 'attribution.kind': 'platform_operation' },
    });
    await UsageEvent.create(fact());
    await expect(UsageEvent.create(fact())).rejects.toMatchObject({ code: 11000 });
    const legacy = {
      requestId: 'same-request',
      userId: 'user-1',
      ownerId: 'user-1',
      ownerType: 'User',
      feature: 'operations',
      provider: 'test-provider',
      model: 'test-model',
      costUsd: 1,
      creditsCharged: 1,
    };
    await UsageEvent.create([legacy, legacy]);
    expect(await UsageEvent.countDocuments({ requestId: 'same-request' })).toBe(2);
  });

  it('registers once, rejects conflicting identity and claims each dispatch only once', async () => {
    await Promise.all([
      platformAttemptRepository.register(registration()),
      platformAttemptRepository.register(registration()),
    ]);
    expect(await PlatformAttempt.countDocuments()).toBe(1);
    await expect(
      platformAttemptRepository.register({ ...registration(), attribution: { ...attribution, executionId: 'other' } })
    ).rejects.toBeInstanceOf(PlatformAccountingConflictError);
    const claimed = await Promise.all([
      platformAttemptRepository.claimDispatch('call-1', at),
      platformAttemptRepository.claimDispatch('call-1', at),
    ]);
    expect(claimed.filter(Boolean)).toHaveLength(1);
  });

  it('does not dispatch an expired intent and does not recover live attempts', async () => {
    await platformAttemptRepository.register(registration());
    expect(await platformAttemptRepository.claimDispatch('call-1', new Date('2026-11-01T00:02:00Z'))).toBe(false);
    expect(await accounting().recover({ now: at, limit: 10 })).toEqual({ recorded: 0, unresolved: 0 });
    expect((await platformAttemptRepository.get('call-1'))?.state).toBe('registered');
  });

  it('records one priced event for concurrent settlements without touching credit funding', async () => {
    await dispatched();
    const loadFunding = vi.spyOn(usageEventRepository as never, 'resolveFundingBreakdown' as never);
    await Promise.all([accounting().settle('call-1', fact()), accounting().settle('call-1', fact())]);
    expect(await UsageEvent.countDocuments()).toBe(1);
    expect((await platformAttemptRepository.get('call-1'))?.state).toBe('recorded');
    const row = await usageEventRepository.findPlatformCall('call-1');
    expect(row).toMatchObject({ creditsCharged: 0, source: 'system', usageOccurredAt: at });
    expect(row).not.toHaveProperty('userId');
    expect(row).not.toHaveProperty('ownerId');
    expect(loadFunding).not.toHaveBeenCalled();
  });

  it('rejects a mismatched provider/model before the first usage stage without mutating the intent', async () => {
    await dispatched();
    for (const changed of [{ provider: 'other' }, { model: 'other' }]) {
      await expect(accounting().settle('call-1', { ...fact(), ...changed })).rejects.toBeInstanceOf(
        PlatformAccountingConflictError
      );
    }
    expect((await platformAttemptRepository.get('call-1'))?.state).toBe('dispatched');
    expect((await platformAttemptRepository.get('call-1'))?.usage).toBeUndefined();
    expect(await UsageEvent.countDocuments()).toBe(0);
  });

  it('rejects immutable provider, price, attribution and usage conflicts on recording retry', async () => {
    await dispatched();
    await accounting().settle('call-1', fact());
    for (const changed of [
      { provider: 'other' },
      { model: 'other' },
      { providerInputTokens: 200, costUsd: 0.0003175 },
      { usageOccurredAt: new Date('2026-10-31T23:59:58Z'), timestampSource: 'provider' as const },
      { status: 'error' as const },
    ]) {
      await expect(accounting().settle('call-1', { ...fact(), ...changed })).rejects.toBeInstanceOf(
        PlatformAccountingConflictError
      );
    }
    expect(await UsageEvent.countDocuments()).toBe(1);
  });

  it('repairs a crash after usage staging using the original identity and no provider callback', async () => {
    await dispatched();
    await platformAttemptRepository.stageUsage('call-1', fact());
    expect(await accounting().recover({ now: at, limit: 10, executionId: 'execution-1' })).toEqual({
      recorded: 1,
      unresolved: 0,
    });
    expect(await accounting().recover({ now: new Date(), limit: 10 })).toEqual({ recorded: 0, unresolved: 0 });
    expect(await UsageEvent.countDocuments()).toBe(1);
  });

  it('repairs a crash between canonical write and journal acknowledgment idempotently', async () => {
    await dispatched();
    await platformAttemptRepository.stageUsage('call-1', fact());
    await usageEventRepository.recordPlatform(fact());
    await accounting().recover({ now: at, limit: 10 });
    expect(await UsageEvent.countDocuments()).toBe(1);
    expect((await platformAttemptRepository.get('call-1'))?.state).toBe('recorded');
  });

  it('retains measured usage through ledger outage and recovers without a new send', async () => {
    await dispatched();
    const failed = vi
      .spyOn(usageEventRepository, 'recordPlatform')
      .mockRejectedValueOnce(new Error('ledger unavailable'));
    await expect(accounting().settle('call-1', fact())).rejects.toBeInstanceOf(PlatformAccountingPendingError);
    expect((await platformAttemptRepository.get('call-1'))?.usage).toMatchObject({ costUsd: fact().costUsd });
    failed.mockRestore();
    await accounting().recover({ now: at, limit: 10 });
    expect(await UsageEvent.countDocuments()).toBe(1);
    expect(await platformAttemptRepository.claimDispatch('call-1', at)).toBe(false);
  });

  it('keeps missing usage and abandoned intents visible without inventing a zero-cost event', async () => {
    await dispatched();
    await accounting().unresolved('call-1', 'aborted_without_usage');
    await platformAttemptRepository.register(registration('call-2'));
    await accounting().recover({ now: new Date('2026-11-01T00:03:00Z'), limit: 10 });
    const rows = await accounting().diagnostics({ limit: 10 });
    expect(rows.total).toBe(2);
    expect(rows.attempts).toHaveLength(2);
    expect(rows.attempts.map(row => row.unresolvedReason).sort()).toEqual(['aborted_without_usage', 'expired_intent']);
    expect(await UsageEvent.countDocuments()).toBe(0);
    expect(await platformAttemptRepository.claimDispatch('call-2', at)).toBe(false);
  });

  it('exposes live and usage-known pending receipts as well as unresolved ones in diagnostics', async () => {
    await dispatched('call-a');
    await platformAttemptRepository.register(registration('call-b'));
    await platformAttemptRepository.stageUsage('call-a', fact('call-a'));
    const diagnostics = await accounting().diagnostics({ limit: 10 });
    expect(diagnostics.total).toBe(2);
    expect(diagnostics.byState).toEqual({ registered: 1, dispatched: 0, usage_known: 1, unresolved: 0 });
    expect(await UsageEvent.countDocuments()).toBe(0);
  });

  it('pages all recoverable and unresolved receipts deterministically without hiding totals', async () => {
    for (const id of ['call-c', 'call-a', 'call-b']) await platformAttemptRepository.register(registration(id));
    const first = await accounting().recover({ now: new Date('2026-11-01T00:03:00Z'), limit: 1 });
    expect(first).toEqual({ recorded: 0, unresolved: 1, nextCursor: 'call-a' });
    const second = await accounting().recover({
      now: new Date('2026-11-01T00:03:00Z'),
      limit: 1,
      afterProviderCallId: first.nextCursor,
    });
    expect(second.nextCursor).toBe('call-b');
    await accounting().recover({
      now: new Date('2026-11-01T00:03:00Z'),
      limit: 1,
      afterProviderCallId: second.nextCursor,
    });
    let cursor: string | undefined;
    const ids: string[] = [];
    do {
      const page = await accounting().diagnostics({ limit: 1, afterProviderCallId: cursor });
      expect(page.total).toBe(3);
      ids.push(...page.attempts.map(row => row.providerCallId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(['call-a', 'call-b', 'call-c']);
    expect(await UsageEvent.countDocuments()).toBe(0);
  });

  it('allows late measured settlement to resolve an unknown outcome without regression', async () => {
    await dispatched();
    await accounting().unresolved('call-1', 'missing_usage');
    await accounting().settle('call-1', { ...fact(), status: 'timeout' });
    await platformAttemptRepository.markUnresolved('call-1', 'missing_usage');
    expect((await platformAttemptRepository.get('call-1'))?.state).toBe('recorded');
    expect(await accounting().diagnostics({ limit: 10 })).toMatchObject({ attempts: [], total: 0 });
  });
});
