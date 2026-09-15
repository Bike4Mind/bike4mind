import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from '../../../__test__/utils';
import { FeedbackModel } from '../FeedbackModel';

// schema.index() calls return [keys, options] pairs; narrowed locally because the mongoose type
// is a broad union that hides expireAfterSeconds.
type DeclaredIndex = [Record<string, number>, { name?: string; expireAfterSeconds?: number } | undefined];

describe('FeedbackModel indexes', () => {
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

  function declaredIndexes(): DeclaredIndex[] {
    return FeedbackModel.schema.indexes() as unknown as DeclaredIndex[];
  }

  it('declares exactly the four expected performance indexes, by name', () => {
    const names = declaredIndexes()
      .map(([, options]) => options?.name)
      .sort();
    expect(names).toEqual(
      [
        'feedback_org_subject_createdAt',
        'feedback_questId_createdAt',
        'feedback_sessionId_createdAt',
        'feedback_userId_createdAt',
      ].sort()
    );
  });

  it('builds all four indexes live in Mongo under the expected names', async () => {
    await FeedbackModel.createIndexes();
    const live = await FeedbackModel.collection.indexes();
    const liveNames = new Set(live.map(idx => idx.name));
    expect(liveNames).toContain('feedback_userId_createdAt');
    expect(liveNames).toContain('feedback_questId_createdAt');
    expect(liveNames).toContain('feedback_sessionId_createdAt');
    expect(liveNames).toContain('feedback_org_subject_createdAt');
  });

  it('declares zero TTL indexes - the permanent document must never expire', () => {
    const ttls = declaredIndexes().filter(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(ttls).toHaveLength(0);
  });

  it('rejects an invalid subject and defaults a missing one to product', async () => {
    const invalid = new FeedbackModel({
      userId: 'u1',
      username: 'user',
      status: 'New',
      subject: 'not-a-real-subject',
    });
    await expect(invalid.validate()).rejects.toThrow();

    const defaulted = new FeedbackModel({
      userId: 'u1',
      username: 'user',
      status: 'New',
    });
    await defaulted.validate();
    expect(defaulted.subject).toBe('product');
    expect(defaulted.contentStored).toBe(false);
  });
});
