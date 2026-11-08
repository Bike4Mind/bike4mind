import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import { User } from '../../auth/UserModel';
import { UsageEvent } from '../../billing/UsageEventModel';
import { loadCompletionSequenceEvents } from '../../auth/completionSequenceEvents';
import {
  ShadowDetectionModel,
  shadowDetectionRepository,
  type RecordShadowDetectionInput,
} from './ShadowDetectionModel';

const ids = [1, 2, 3].map(n => n.toString(16).padStart(24, '0'));
const at = new Date('2026-01-01T12:00:00Z');
const observation = (last = at): RecordShadowDetectionInput => ({
  detector: 'completionSequence',
  policyVersion: 1,
  wouldAction: 'none',
  userIds: ids,
  detectedAt: last,
  summary: 'Repeated settlement order',
  group: null,
  network: null,
  payment: null,
  signals: [],
  windowMinutes: 1440,
  completionSequence: {
    source: 'completion_usage_ledger',
    windowHours: 24,
    eventsScanned: 6,
    scanTruncated: false,
    rounds: 2,
    minRequestsPerRound: 3,
    maxRequestsPerRound: 3,
    maxRoundSpanSeconds: 10,
    minGapSeconds: 60,
    maxGapSeconds: 60,
    firstObservedAt: new Date(at.getTime() - 120_000),
    lastObservedAt: last,
  },
});

describe('completion sequence persistence', () => {
  setupMongoTest();
  beforeEach(async () => {
    await Promise.all([
      User.collection.deleteMany({}),
      ShadowDetectionModel.deleteMany({}),
      UsageEvent.collection.deleteMany({}),
    ]);
    await User.collection.insertMany(ids.map(id => ({ _id: new Types.ObjectId(id), deletedAt: null })));
  });

  it('deduplicates concurrent retries and advances revision only for new evidence', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => shadowDetectionRepository.recordCompletionSequence(observation()))
    );
    expect(results.filter(result => result === 'created')).toHaveLength(1);
    expect(await ShadowDetectionModel.countDocuments()).toBe(1);
    expect(await shadowDetectionRepository.countOpenForUser(ids[0])).toBe(0);
    expect(await shadowDetectionRepository.recordCompletionSequence(observation())).toBe('unchanged');
    expect(await shadowDetectionRepository.recordCompletionSequence(observation(new Date(at.getTime() + 60_000)))).toBe(
      'updated'
    );
    const { data } = await shadowDetectionRepository.list({ limit: 10 });
    expect(data[0]).toMatchObject({ revision: 1, wouldAction: 'none', completionSequence: { rounds: 2 } });
  });

  it('preserves human verdicts and opens a new observation on another activity day', async () => {
    await shadowDetectionRepository.recordCompletionSequence(observation());
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
    expect(await shadowDetectionRepository.recordCompletionSequence(observation(new Date(at.getTime() + 60_000)))).toBe(
      'unchanged'
    );
    expect(
      await shadowDetectionRepository.recordCompletionSequence(observation(new Date('2026-01-02T12:00:00Z')))
    ).toBe('created');
    expect(await ShadowDetectionModel.countDocuments()).toBe(2);
  });

  it('removes the whole ordered observation when a participant is removed and refuses to recreate it', async () => {
    await shadowDetectionRepository.recordCompletionSequence(observation());
    await User.collection.deleteOne({ _id: new Types.ObjectId(ids[1]) });
    await shadowDetectionRepository.removeUser(ids[1]);
    expect(await ShadowDetectionModel.countDocuments()).toBe(0);
    expect(await shadowDetectionRepository.recordCompletionSequence(observation())).toBe('unchanged');
    expect(await ShadowDetectionModel.countDocuments()).toBe(0);
  });

  it('reconciles an upsert racing with participant purge', async () => {
    const original = ShadowDetectionModel.updateOne.bind(ShadowDetectionModel);
    const write = vi.spyOn(ShadowDetectionModel, 'updateOne').mockImplementationOnce((...args) => {
      const pending = (async () => {
        await User.collection.updateOne(
          { _id: new Types.ObjectId(ids[1]) },
          { $set: { 'deletion.purgeStartedAt': at } }
        );
        await shadowDetectionRepository.removeUser(ids[1]);
        return original(...args);
      })();
      // The repository awaits this query; inject the purge between its pre-check and write.
      return pending as unknown as ReturnType<typeof ShadowDetectionModel.updateOne>;
    });
    try {
      expect(await shadowDetectionRepository.recordCompletionSequence(observation())).toBe('unchanged');
      expect(await ShadowDetectionModel.countDocuments()).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('retains unavailable accounts as barriers and excludes failed, non-API and old settlements', async () => {
    await User.collection.updateOne({ _id: new Types.ObjectId(ids[1]) }, { $set: { 'deletion.purgeStartedAt': at } });
    await UsageEvent.collection.insertMany([
      ...ids.map((userId, n) => ({
        userId,
        requestId: `request-${n}`,
        feature: 'completion_api',
        status: 'ok',
        createdAt: new Date(at.getTime() - 1000 * (n + 1)),
      })),
      {
        userId: ids[0],
        requestId: 'failed',
        feature: 'completion_api',
        status: 'failed',
        createdAt: new Date(at.getTime() - 1000),
      },
      { userId: ids[0], requestId: 'chat', feature: 'chat', status: 'ok', createdAt: new Date(at.getTime() - 1000) },
      { userId: ids[0], requestId: 'old', feature: 'completion_api', status: 'ok', createdAt: new Date('2025-01-01') },
    ]);
    const scan = await loadCompletionSequenceEvents(at);
    expect(scan.rowsScanned).toBe(3);
    expect(scan.events.find(event => event.userId === ids[1])?.eligible).toBe(false);
    expect(scan.events.filter(event => event.eligible)).toHaveLength(2);
  });
});
