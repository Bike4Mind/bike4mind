import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { CreditHolderType } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import { User } from '../../auth/UserModel';
import { ApiKeyUsageLog, apiKeyUsageLogRepository } from '../../auth/ApiKeyUsageLogModel';
import { UsageEvent } from '../../billing/UsageEventModel';
import { loadCompletionCohortExposure } from '../../auth/completionCohortExposure';
import { loadCompletionSynchronyEvents } from '../../auth/completionSynchronyEvents';
import {
  ShadowDetectionModel,
  shadowDetectionRepository,
  type RecordShadowDetectionInput,
} from './ShadowDetectionModel';
const ids = [1, 2, 3].map(n => n.toString(16).padStart(24, '0'));
const now = new Date();
const evidence = {
  scannedAt: now,
  source: 'api_key_request_starts' as const,
  windowHours: 24 as const,
  eventsScanned: 9,
  legacyRows: 0,
  scanTruncated: false,
  bursts: 3,
  synchronizedModelSwitches: 1,
  distinctRequestedModels: 2,
  maxStartSkewMilliseconds: 400,
  completedRequests: 6,
  dailyCapRejectedRequests: 3,
  otherRejectedRequests: 0,
  interruptedOrUnknownRequests: 0,
  firstObservedAt: new Date(now.getTime() - 300_000),
  lastObservedAt: now,
};
const observation = (): RecordShadowDetectionInput => ({
  detector: 'completionSynchrony',
  policyVersion: 1,
  wouldAction: 'none',
  userIds: ids,
  detectedAt: now,
  summary: 'Repeated synchronized starts',
  group: null,
  network: null,
  payment: null,
  signals: [],
  windowMinutes: 1440,
  completionSynchrony: evidence,
});
const startInput = () => ({
  keyId: 'synthetic-key',
  userId: ids[0],
  ipAddress: '203.0.113.1',
  endpoint: '/api/ai/v1/completions',
  method: 'POST',
  source: 'api' as const,
  ownerType: CreditHolderType.User,
  completionObservation: {
    requestId: 'synthetic-request',
    requestedModel: 'model-alpha',
    startedAt: new Date(now.getTime() - 60_000).toISOString(),
    outcome: 'unknown' as const,
  },
});

describe('synchronized API observation storage', () => {
  setupMongoTest();
  beforeEach(async () => {
    await Promise.all([
      User.collection.deleteMany({}),
      ApiKeyUsageLog.deleteMany({}),
      UsageEvent.collection.deleteMany({}),
      ShadowDetectionModel.deleteMany({}),
    ]);
    await User.collection.insertMany(ids.map(id => ({ _id: new Types.ObjectId(id), deletedAt: null })));
  });
  it('keeps daily observation identity stable across membership ordering and concurrent retries', async () => {
    await Promise.all([
      shadowDetectionRepository.recordCompletionSynchrony(observation()),
      shadowDetectionRepository.recordCompletionSynchrony({ ...observation(), userIds: [...ids].reverse() }),
    ]);
    expect(await ShadowDetectionModel.countDocuments()).toBe(1);
    const { data } = await shadowDetectionRepository.list({ limit: 10 });
    expect(data[0].completionSynchrony).toMatchObject({ bursts: 3, dailyCapRejectedRequests: 3 });
    expect(await shadowDetectionRepository.countOpenForUser(ids[0])).toBe(0);
  });
  it('refreshes settled outcomes and recovered exposure without requiring new request starts', async () => {
    const initial = observation();
    await shadowDetectionRepository.recordCompletionSynchrony({
      ...initial,
      completionSynchrony: { ...evidence, completedRequests: 0, interruptedOrUnknownRequests: 9 },
    });
    const fresh = {
      ...evidence,
      scannedAt: new Date(now.getTime() + 60_000),
      creditExposure: {
        scope: 'cohort_completion_api_24h' as const,
        creditsCharged: 12,
        grantFundedCredits: 5,
        unknownFundingCredits: 7,
        scanTruncated: false,
      },
    };
    expect(await shadowDetectionRepository.recordCompletionSynchrony({ ...initial, completionSynchrony: fresh })).toBe(
      'updated'
    );
    expect(await shadowDetectionRepository.recordCompletionSynchrony(initial)).toBe('unchanged');
    const {
      data: [row],
    } = await shadowDetectionRepository.list({ limit: 10 });
    expect(row).toMatchObject({
      revision: 1,
      completionSynchrony: {
        completedRequests: 6,
        interruptedOrUnknownRequests: 0,
        creditExposure: { creditsCharged: 12 },
      },
    });
  });

  it('keeps reviewed evidence immutable and removes the whole record on participant purge', async () => {
    await shadowDetectionRepository.recordCompletionSynchrony(observation());
    const {
      data: [row],
    } = await shadowDetectionRepository.list({ limit: 10 });
    await shadowDetectionRepository.addVerdict({
      id: row.id,
      expectedRevision: 0,
      verdict: 'legitimate_automation',
      reason: 'Verified team scheduler',
      reviewerId: 'reviewer',
    });
    expect(
      await shadowDetectionRepository.recordCompletionSynchrony({
        ...observation(),
        completionSynchrony: {
          ...evidence,
          scannedAt: new Date(now.getTime() + 60_000),
          lastObservedAt: new Date(now.getTime() + 60_000),
          bursts: 4,
        },
      })
    ).toBe('unchanged');
    await shadowDetectionRepository.removeUser(ids[1]);
    expect(await ShadowDetectionModel.countDocuments()).toBe(0);
  });
  it('records a durable unknown start before any response and updates that same row', async () => {
    const id = await apiKeyUsageLogRepository.beginCompletionObservation(startInput());
    expect(id).not.toBeNull();
    expect(await ApiKeyUsageLog.findById(id).lean()).toMatchObject({
      statusCode: 0,
      completionObservation: { outcome: 'unknown' },
    });
    await apiKeyUsageLogRepository.finishCompletionObservation(id!, ids[0], {
      statusCode: 429,
      responseTime: 20,
      completionObservation: { ...startInput().completionObservation, outcome: 'daily_cap_rejected' },
    });
    expect(await ApiKeyUsageLog.countDocuments()).toBe(1);
    expect(await ApiKeyUsageLog.findById(id).lean()).toMatchObject({
      statusCode: 429,
      completionObservation: { outcome: 'daily_cap_rejected' },
    });
  });
  it('does not recreate a removed start and refuses new starts for a purging participant', async () => {
    const id = await apiKeyUsageLogRepository.beginCompletionObservation(startInput());
    await User.collection.updateOne({ _id: new Types.ObjectId(ids[0]) }, { $set: { 'deletion.purgeStartedAt': now } });
    await ApiKeyUsageLog.deleteMany({ userId: ids[0] });
    await apiKeyUsageLogRepository.finishCompletionObservation(id!, ids[0], {
      statusCode: 200,
      responseTime: 20,
      completionObservation: { ...startInput().completionObservation, outcome: 'completed' },
    });
    expect(await ApiKeyUsageLog.countDocuments()).toBe(0);
    expect(await apiKeyUsageLogRepository.beginCompletionObservation(startInput())).toBeNull();
  });
  it('removes a new start inserted concurrently with a participant purge marker', async () => {
    const original = ApiKeyUsageLog.updateOne.bind(ApiKeyUsageLog);
    const write = vi.spyOn(ApiKeyUsageLog, 'updateOne').mockImplementationOnce((...args) => {
      const pending = (async () => {
        await User.collection.updateOne(
          { _id: new Types.ObjectId(ids[0]) },
          { $set: { 'deletion.purgeStartedAt': now } }
        );
        return original(...args);
      })();
      return pending as unknown as ReturnType<typeof ApiKeyUsageLog.updateOne>;
    });
    try {
      expect(await apiKeyUsageLogRepository.beginCompletionObservation(startInput())).toBeNull();
      expect(await ApiKeyUsageLog.countDocuments()).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('distinguishes grant funding from purchased and unknown funding in cohort spend', async () => {
    await UsageEvent.collection.insertMany([
      {
        userId: ids[0],
        feature: 'completion_api',
        status: 'ok',
        createdAt: new Date(now.getTime() - 1000),
        creditsCharged: 10,
        fundingBreakdown: { granted: 5, purchased: 5, subscription: 0, unknown: 0 },
      },
      {
        userId: ids[0],
        feature: 'completion_api',
        status: 'ok',
        createdAt: new Date(now.getTime() - 1000),
        creditsCharged: 3,
      },
      { userId: ids[0], feature: 'chat', status: 'ok', createdAt: new Date(now.getTime() - 1000), creditsCharged: 99 },
    ]);
    expect(await loadCompletionCohortExposure(ids, now)).toEqual({
      accounts: [{ userId: ids[0], creditsCharged: 13, grantFundedCredits: 5, unknownFundingCredits: 3 }],
      truncated: false,
    });
  });

  it('keeps legacy coverage unknown and reads start time rather than finish time', async () => {
    await ApiKeyUsageLog.collection.insertMany([
      {
        userId: ids[0],
        timestamp: new Date(now.getTime() - 1000),
        endpoint: '/api/ai/v1/completions',
        completionObservation: { ...startInput().completionObservation, outcome: 'daily_cap_rejected' },
      },
      { userId: ids[1], timestamp: new Date(now.getTime() - 500), endpoint: '/api/ai/v1/completions' },
    ]);
    const scan = await loadCompletionSynchronyEvents(now);
    expect(scan).toMatchObject({ rowsScanned: 2, legacyRows: 1, truncated: false });
    expect(scan.events).toHaveLength(1);
    expect(scan.events[0]).toMatchObject({
      userId: ids[0],
      at: new Date(now.getTime() - 60_000),
      outcome: 'daily_cap_rejected',
      eligible: true,
    });
  });
});
