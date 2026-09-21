import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from '../../../__test__/utils';
import { FeedbackModel } from '../FeedbackModel';

// schema.index() calls return [keys, options] pairs; narrowed locally because the mongoose type
// is a broad union that hides expireAfterSeconds.
type DeclaredIndex = [
  Record<string, number>,
  { name?: string; expireAfterSeconds?: number; unique?: boolean; partialFilterExpression?: unknown } | undefined,
];

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

  const EXPECTED_INDEX_NAMES = [
    'feedback_helpContext_eventId',
    'feedback_org_createdAt',
    'feedback_org_subject_createdAt',
    'feedback_questId_createdAt',
    'feedback_sessionId_createdAt',
    'feedback_userId_createdAt',
  ];

  it('declares exactly the expected performance indexes, by name', () => {
    const names = declaredIndexes()
      .map(([, options]) => options?.name)
      .sort();
    expect(names).toEqual([...EXPECTED_INDEX_NAMES].sort());
  });

  it('builds every index live in Mongo under the expected names', async () => {
    await FeedbackModel.createIndexes();
    const live = await FeedbackModel.collection.indexes();
    const liveNames = new Set(live.map(idx => idx.name));
    for (const name of EXPECTED_INDEX_NAMES) {
      expect(liveNames).toContain(name);
    }
  });

  /**
   * The help router finds-or-creates one report per help event across two round trips, so this
   * index is the only thing serializing two concurrent submissions. It has to be unique, and it
   * has to be partial rather than sparse - sparse would index every non-help report under a null
   * key and collide them against each other.
   */
  it('makes the help-event index unique and partial, not sparse', () => {
    const [, options] = declaredIndexes().find(([, o]) => o?.name === 'feedback_helpContext_eventId')!;
    expect(options?.unique).toBe(true);
    expect(options?.partialFilterExpression).toEqual({ 'helpContext.eventId': { $exists: true } });
    expect(options).not.toHaveProperty('sparse');
  });

  it('refuses a second report against the same help event', async () => {
    await FeedbackModel.createIndexes();
    const helpContext = { eventId: 'aaaaaaaaaaaaaaaaaaaaaaaa', surface: 'article' as const, slug: 'a' };
    const base = { userId: 'u1', status: 'New', username: 'u', type: 'Feedback', subject: 'help' as const };

    await FeedbackModel.create({ ...base, helpContext });

    await expect(FeedbackModel.create({ ...base, helpContext })).rejects.toThrow(/E11000/);
  });

  /**
   * The partial filter is what keeps that uniqueness off every other report - without it the
   * second non-help row would collide on a null key.
   */
  it('still allows many reports that carry no help context', async () => {
    await FeedbackModel.createIndexes();
    const base = { userId: 'u1', status: 'New', username: 'u', type: 'Feedback' };

    await FeedbackModel.create({ ...base, subject: 'product' });
    await FeedbackModel.create({ ...base, subject: 'product' });

    expect(await FeedbackModel.countDocuments({})).toBe(2);
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

  /**
   * `helpContext.eventId` is both the join key the help read path stitches on and the key the
   * unique index above is declared against. A drift in this sub-schema does not fail loudly: an
   * unindexed or absent eventId just makes the routed comment unfindable, so the panel renders
   * every row commentless and the uniqueness that serializes the router stops applying.
   */
  describe('helpContext sub-schema', () => {
    const base = { userId: 'u1', username: 'user', status: 'New', subject: 'help' as const };

    it('requires an eventId', async () => {
      const doc = new FeedbackModel({ ...base, helpContext: { surface: 'article' } });
      await expect(doc.validate()).rejects.toThrow();
    });

    it.each([
      ['surface', { eventId: 'e1', surface: 'sidebar' }],
      ['reportType', { eventId: 'e1', surface: 'article', reportType: 'wrong' }],
    ])('rejects an unknown %s', async (_field, helpContext) => {
      await expect(new FeedbackModel({ ...base, helpContext }).validate()).rejects.toThrow();
    });

    /**
     * The verdict lives on the parent's `type`. A `rating` here would be a second copy that no
     * reader consults and that a concurrent verdict write could leave disagreeing with `type`, so
     * the sub-schema drops it rather than storing it - pinned because the drop is silent.
     */
    it('carries no rating, so one supplied by a stale writer is not stored', async () => {
      const doc = new FeedbackModel({
        ...base,
        helpContext: { eventId: 'e1', surface: 'article', rating: 'not_helpful' },
      });
      await doc.validate();
      expect(doc.helpContext).not.toHaveProperty('rating');
    });

    it('requires a surface, and accepts a context carrying nothing else', async () => {
      await expect(new FeedbackModel({ ...base, helpContext: { eventId: 'e1' } }).validate()).rejects.toThrow();

      // The chat surface has neither a slug nor anything to report as outdated.
      const chat = new FeedbackModel({ ...base, helpContext: { eventId: 'e1', surface: 'chat' } });
      await chat.validate();
      expect(chat.helpContext?.slug).toBeUndefined();
      expect(chat.helpContext?.reportType).toBeUndefined();
    });
  });
});
