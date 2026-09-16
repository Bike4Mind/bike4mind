import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, FeedbackTextModel, HelpEventModel, User } from '@bike4mind/database';
import { FEEDBACK_CONTENT_RETENTION_DAYS } from '@bike4mind/common';
import errorHandler from '@server/middlewares/errorHandler';
import { routeHelpCommentToFeedback } from '@server/utils/helpFeedbackRouting';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Round-trip cover for the help/Feedback consolidation: a comment is human-written and must land
 * in `Feedback` (with its text in the TTL'd sibling), while the behavior half stays on the help
 * event - and `my-feedback` has to read both back as the one shape its clients already consume.
 *
 * Deliberately unmocked below the handler: the retention guarantee and the dedup-to-one-report
 * behavior are both properties of the real writes, and a mocked model would assert nothing.
 */

type CapturedHandler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  captured: [] as CapturedHandler[],
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,
    get: (fn: CapturedHandler) => {
      mockRefs.captured.push(fn);
      return chain;
    },
    post: (fn: CapturedHandler) => {
      mockRefs.captured.push(fn);
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let mongoServer: MongoMemoryServer;
let articleHandler: CapturedHandler;
let chatHandler: CapturedHandler;
let myFeedbackHandler: CapturedHandler;
let adminAnalyticsHandler: CapturedHandler;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());

  // Imported one at a time so each module's captured handler can be claimed before the next
  // registers its own - a static import list would leave three anonymous entries in one array.
  await import('../feedback');
  articleHandler = mockRefs.captured.pop()!;
  await import('../chat-feedback');
  chatHandler = mockRefs.captured.pop()!;
  await import('../my-feedback');
  myFeedbackHandler = mockRefs.captured.pop()!;
  await import('../../admin/help-analytics');
  adminAnalyticsHandler = mockRefs.captured.pop()!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

// dropDatabase above takes the indexes with it, so without this every test would run against a
// collection with no unique constraint - and the two race tests below would pass vacuously.
beforeEach(async () => {
  await FeedbackModel.createIndexes();
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

async function makeUser() {
  return User.create({ username: 'help-user', name: 'Help User', email: 'help-user@example.com' });
}

async function call(
  handler: CapturedHandler,
  method: 'GET' | 'POST',
  user: { id: string; username: string; email: string; isAdmin?: boolean },
  body?: Record<string, unknown>
) {
  const { req, res } = createMocks({ method, body, query: {} });
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
  (req as unknown as { user: typeof user }).user = user;
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';
  try {
    await handler(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
  return res;
}

describe('help feedback consolidation', () => {
  it('routes an article comment to Feedback and leaves only behavior on the help event', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, {
      slug: 'getting-started',
      rating: 'not_helpful',
      comment: 'this section is wrong',
    });

    const events = await HelpEventModel.find({ type: 'article_feedback' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].rating).toBe('not_helpful');
    expect(events[0].slug).toBe('getting-started');
    // The whole point of the split: nothing a human wrote is left in the behavior store.
    expect(events[0].comment).toBeUndefined();

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].subject).toBe('help');
    expect(reports[0].contentStored).toBe(true);
    // Never on the permanent record - only in the TTL'd sibling.
    expect(reports[0].content).toBeUndefined();
    expect(reports[0].helpContext).toMatchObject({
      eventId: events[0]._id.toString(),
      surface: 'article',
      slug: 'getting-started',
      rating: 'not_helpful',
    });

    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('this section is wrong');
  });

  it('gives the routed text the same 90-day window the help event already had', async () => {
    const user = await makeUser();
    const before = Date.now();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'nice' });

    const report = await FeedbackModel.findOne({}).lean();
    const text = await FeedbackTextModel.findById(report!._id).lean();
    const expectedMs = FEEDBACK_CONTENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // A 90-day window moving to a 90-day window - consolidation must not extend retention.
    expect(text!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(text!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + expectedMs);
  });

  it('revises the one report in the dedup window without extending its retention', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'first draft' });
    const firstReport = await FeedbackModel.findOne({}).lean();

    // Bypasses mongoose so the sentinel survives the schema's `immutable` guard - the assertion
    // below is about the revise path not re-stamping expiresAt, not about mongoose stripping it.
    const sentinel = new Date('2030-01-02T03:04:05.000Z');
    await FeedbackTextModel.collection.updateOne({ _id: firstReport!._id }, { $set: { expiresAt: sentinel } });

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'revised text' });

    expect(await HelpEventModel.countDocuments({ type: 'article_feedback' })).toBe(1);
    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0]._id.toString()).toBe(firstReport!._id.toString());
    // The rating can flip mid-edit, so the copied context has to follow it.
    expect(reports[0].helpContext?.rating).toBe('not_helpful');

    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('revised text');
    expect(text?.expiresAt.toISOString()).toBe(sentinel.toISOString());
  });

  it('attaches a comment-only revision to the rating the user already left', async () => {
    const user = await makeUser();

    // Rating first, then a bare comment: the second call has nothing to $set on the event, and
    // must still find it rather than opening a second, ratingless one.
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });
    const res = await call(articleHandler, 'POST', user, { slug: 'a', comment: 'one more thing' });

    expect(res._getStatusCode()).toBe(200);
    expect(await HelpEventModel.countDocuments({ type: 'article_feedback' })).toBe(1);

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    // The rating lives on the event, not in this request - the copied context has to pick it up.
    expect(reports[0].helpContext?.rating).toBe('helpful');
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('one more thing');
  });

  it('writes no report for a bare rating, which is behavior-shaped and stays put', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });
    await call(articleHandler, 'POST', user, { slug: 'b', reportType: 'outdated' });

    expect(await FeedbackModel.countDocuments({})).toBe(0);
    expect(await HelpEventModel.countDocuments({ type: 'article_feedback' })).toBe(2);
  });

  it('keeps a chat comment free of the question and answer text', async () => {
    const user = await makeUser();

    await call(chatHandler, 'POST', user, {
      chatQuestion: 'how do I export?',
      chatAnswer: 'you cannot',
      rating: 'not_helpful',
      comment: 'that is not true',
    });

    const event = await HelpEventModel.findOne({ type: 'chat_feedback' }).lean();
    expect(event?.comment).toBeUndefined();

    const report = await FeedbackModel.findOne({}).lean();
    expect(report?.helpContext).toMatchObject({
      eventId: event!._id.toString(),
      surface: 'chat',
      rating: 'not_helpful',
    });
    // Free text, so it stays on the TTL'd event rather than being copied onto a permanent row.
    expect(report?.helpContext?.slug).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain('how do I export?');
  });

  it('reads both stores back as the shape the help clients already consume', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, {
      slug: 'getting-started',
      rating: 'not_helpful',
      comment: 'this section is wrong',
    });
    await call(chatHandler, 'POST', user, {
      chatQuestion: 'how do I export?',
      chatAnswer: 'you cannot',
      rating: 'not_helpful',
      comment: 'that is not true',
    });

    const res = await call(myFeedbackHandler, 'GET', user);
    const body = res._getJSONData();

    expect(body.articleFeedback).toHaveLength(1);
    expect(body.articleFeedback[0]).toMatchObject({
      slug: 'getting-started',
      rating: 'not_helpful',
      comment: 'this section is wrong',
    });
    // HelpChat.tsx matches an entry by exact (chatQuestion, chatAnswer) equality, so these two
    // fields must survive the round trip verbatim or the panel silently stops pre-filling.
    expect(body.chatFeedback).toHaveLength(1);
    expect(body.chatFeedback[0]).toMatchObject({
      chatQuestion: 'how do I export?',
      chatAnswer: 'you cannot',
      rating: 'not_helpful',
      comment: 'that is not true',
    });
  });

  it('still reads back a comment written before the split, from the help event itself', async () => {
    const user = await makeUser();
    await HelpEventModel.create({
      type: 'article_feedback',
      userId: user.id,
      slug: 'legacy',
      rating: 'helpful',
      comment: 'written before the consolidation',
    });

    const res = await call(myFeedbackHandler, 'GET', user);
    const body = res._getJSONData();

    expect(body.articleFeedback[0].comment).toBe('written before the consolidation');
  });

  it('stitches routed comments back into the admin help analytics tab', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'admin should see this' });
    await call(chatHandler, 'POST', user, {
      chatQuestion: 'q',
      chatAnswer: 'a',
      rating: 'not_helpful',
      comment: 'and this one',
    });

    const admin = { id: user.id, username: user.username, email: user.email, isAdmin: true };
    const res = await call(adminAnalyticsHandler, 'GET', admin);
    const body = res._getJSONData();

    // This tab reads the same comments through a second projection; without the stitch it renders
    // every row commentless rather than failing, which is why it is asserted rather than assumed.
    expect(body.recentFeedback[0].comment).toBe('admin should see this');
    expect(body.chatFeedback[0].comment).toBe('and this one');
  });

  it('fails the submission rather than saving a help report with no comment', async () => {
    const user = await makeUser();
    const createSpy = vi
      .spyOn(FeedbackTextModel, 'create')
      .mockRejectedValueOnce(new Error('text store unavailable') as never);

    const res = await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'lost?' });

    expect(createSpy).toHaveBeenCalled();
    expect(res._getStatusCode()).toBeGreaterThanOrEqual(500);
    // A help report IS its comment - persisting one without text would answer 201 for a comment
    // that no longer exists anywhere.
    expect(await FeedbackModel.countDocuments({})).toBe(0);
    createSpy.mockRestore();
  });

  it("does not leak another user's routed comment into my panel", async () => {
    const mine = await makeUser();
    const theirs = await User.create({ username: 'other', name: 'Other', email: 'other@example.com' });

    await call(articleHandler, 'POST', theirs, { slug: 'shared', rating: 'helpful', comment: 'their note' });
    await call(articleHandler, 'POST', mine, { slug: 'shared', rating: 'helpful' });

    const res = await call(myFeedbackHandler, 'GET', mine);
    const body = res._getJSONData();

    expect(body.articleFeedback).toHaveLength(1);
    expect(body.articleFeedback[0].comment).toBeUndefined();
  });

  /**
   * Zod puts no `.min(1)` on `comment`, so a whitespace-only note reaches the router as a real
   * string. The trim guard is the only thing between it and a permanent report that says nothing,
   * and it has to stay on the RAW text - see writeFeedbackText's contract.
   */
  it('writes no report for a whitespace-only comment', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: '   \n  ' });

    expect(await FeedbackModel.countDocuments({})).toBe(0);
    expect(await HelpEventModel.countDocuments({ type: 'article_feedback' })).toBe(1);
  });

  /**
   * Once the text sibling ages out under its TTL the report itself remains, so the read half has
   * to drop that event's comment rather than surfacing an empty string as if the user wrote one.
   */
  it('reads back no comment once the text sibling has been swept', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'will age out' });

    const report = await FeedbackModel.findOne({}).lean();
    await FeedbackTextModel.deleteOne({ _id: report!._id });

    const body = (await call(myFeedbackHandler, 'GET', user))._getJSONData();
    expect(body.articleFeedback).toHaveLength(1);
    expect(body.articleFeedback[0].comment).toBeUndefined();
    // The report is permanent and still says which article it was about.
    expect(report!.helpContext?.slug).toBe('a');
  });

  /**
   * `reportType` is copied for the same reason the rating is: the event it came from expires in
   * 90 days and the report does not, so an admin triaging later would otherwise lose the single
   * strongest signal the help center emits.
   */
  it('copies the outdated flag onto the routed report', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, {
      slug: 'a',
      rating: 'not_helpful',
      reportType: 'outdated',
      comment: 'steps no longer match the UI',
    });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].helpContext?.reportType).toBe('outdated');
  });

  /**
   * The thumbs and the comment are two independent submissions, so a user can leave a note and
   * then flip the thumb without retyping it. The report that note created has to follow, or an
   * admin triages a "Thumbs Down" that the user already moved away from.
   */
  it('carries a rating flipped after the comment onto the routed report', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'this article is wrong' });
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('Thumbs Up');
    expect(reports[0].helpContext?.rating).toBe('helpful');
    // The note itself is untouched by a rating change.
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('this article is wrong');
  });

  it('carries a flipped chat rating onto the routed report too', async () => {
    const user = await makeUser();
    const chat = { chatQuestion: 'q', chatAnswer: 'a' };

    await call(chatHandler, 'POST', user, { ...chat, rating: 'helpful', comment: 'actually incomplete' });
    await call(chatHandler, 'POST', user, { ...chat, rating: 'not_helpful' });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('Thumbs Down');
    expect(reports[0].helpContext?.rating).toBe('not_helpful');
  });

  /**
   * The sync is update-only on purpose: a user who rates without ever writing anything has left
   * behavior, not feedback, and it stays in the help event store.
   */
  it('creates no report when a rating changes on an article nobody commented on', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful' });

    expect(await FeedbackModel.countDocuments({})).toBe(0);
  });

  /**
   * The find-or-create in the router is two round trips, so the database is what has to refuse a
   * second report for one help event. Asserted directly because the collapse-to-one behavior in
   * the next test rests entirely on this constraint existing.
   */
  it('refuses a second report for one help event at the index', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'first' });
    const report = await FeedbackModel.findOne({}).lean();

    await expect(
      FeedbackModel.create({
        userId: user.id,
        status: 'New',
        username: 'help-user',
        type: 'Feedback',
        subject: 'help',
        helpContext: report!.helpContext,
        contentStored: false,
      })
    ).rejects.toThrow(/E11000/);
  });

  /**
   * A double-submit, a retried request or a second tab puts two writes on one help event at once.
   * Whichever way they interleave - both reads missing, or the second serializing behind the
   * first - the pair has to converge on a single report rather than giving an admin the same
   * comment twice, and must leave no orphaned text sibling behind.
   */
  it('collapses two concurrent submissions for one help event into one report', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });
    const event = await HelpEventModel.findOne({}).lean();

    const submitter = { id: user.id, username: user.username, email: user.email };
    const helpContext = {
      eventId: event!._id.toString(),
      surface: 'article' as const,
      slug: 'a',
      rating: 'helpful' as const,
    };
    const logger = stubLogger() as Parameters<typeof routeHelpCommentToFeedback>[0]['logger'];

    await Promise.all([
      routeHelpCommentToFeedback({ submitter, comment: 'racing note A', helpContext, logger }),
      routeHelpCommentToFeedback({ submitter, comment: 'racing note B', helpContext, logger }),
    ]);

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    // Last writer wins, but both are valid outcomes of a race - the assertion is that one of the
    // two comments survived intact, not which.
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(['racing note A', 'racing note B']).toContain(text?.content);
    // The loser rolled its own sibling back rather than stranding it under the 90-day TTL.
    expect(await FeedbackTextModel.countDocuments({})).toBe(1);
  });
});
