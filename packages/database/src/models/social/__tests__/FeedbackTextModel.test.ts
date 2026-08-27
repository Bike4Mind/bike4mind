import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { feedbackContentExpiresAt, FEEDBACK_CONTENT_RETENTION_DAYS } from '@bike4mind/common';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from '../../../__test__/utils';
import { FeedbackTextModel } from '../FeedbackTextModel';

type DeclaredIndex = [Record<string, number>, { name?: string; expireAfterSeconds?: number } | undefined];

describe('FeedbackTextModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await connectTestDB();
  }, 30000);

  afterAll(async () => {
    if (mongoServer) await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await cleanupTestDB();
  });

  it('declares exactly one TTL index, on expiresAt, immediate expiry', () => {
    const declared = FeedbackTextModel.schema.indexes() as unknown as DeclaredIndex[];
    const ttls = declared.filter(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(ttls).toHaveLength(1);

    const [keys, options] = ttls[0];
    expect(keys).toEqual({ expiresAt: 1 });
    expect(options?.expireAfterSeconds).toBe(0);
    expect(options?.name).toBe('feedback_text_ttl');
  });

  it('builds the TTL index live in Mongo', async () => {
    await FeedbackTextModel.createIndexes();
    const live = await FeedbackTextModel.collection.indexes();
    const ttl = live.find(idx => idx.name === 'feedback_text_ttl');
    expect(ttl, 'feedback_text_ttl index missing from the collection').toBeDefined();
    expect(ttl?.expireAfterSeconds).toBe(0);
  });

  it('joins back to its owning Feedback report via a shared _id', async () => {
    const feedbackId = new mongoose.Types.ObjectId();
    const expiresAt = feedbackContentExpiresAt(new Date());
    await FeedbackTextModel.create({ _id: feedbackId, content: 'the report body', expiresAt });

    const found = await FeedbackTextModel.findById(feedbackId);
    expect(found?.content).toBe('the report body');
  });

  it('cannot have its expiresAt extended after creation', async () => {
    const feedbackId = new mongoose.Types.ObjectId();
    const originalExpiry = feedbackContentExpiresAt(new Date());
    const doc = await FeedbackTextModel.create({ _id: feedbackId, content: 'body', expiresAt: originalExpiry });

    doc.expiresAt = new Date(originalExpiry.getTime() + 1000 * 60 * 60 * 24 * 365);
    await doc.save();

    const reloaded = await FeedbackTextModel.findById(feedbackId);
    expect(reloaded?.expiresAt.getTime()).toBe(originalExpiry.getTime());
  });

  it('feedbackContentExpiresAt derives a 90-day window from createdAt', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expires = feedbackContentExpiresAt(now);
    const days = (expires.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(FEEDBACK_CONTENT_RETENTION_DAYS);
  });
});
