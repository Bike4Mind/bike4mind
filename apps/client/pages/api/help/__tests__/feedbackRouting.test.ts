import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, FeedbackTextModel, HelpEventModel, Organization, User } from '@bike4mind/database';
import { FEEDBACK_CONTENT_RETENTION_DAYS, FeedbackType } from '@bike4mind/common';
import errorHandler from '@server/middlewares/errorHandler';
import { routeHelpCommentToFeedback, stitchRoutedComments, syncRoutedVerdict } from '@server/utils/helpFeedbackRouting';
import { saveFeedbackOrRollbackText } from '@server/utils/feedbackText';

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
  // restoreAllMocks, not just clearAllMocks: clear wipes call history but leaves a spy's
  // implementation in place, so one that escapes a failing test rewrites every test after it.
  vi.restoreAllMocks();
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
  // username/email are optional so the identity-fallback cases below can omit them, the way a
  // session carrying neither display field reaches the router in production.
  user: { id: string; username?: string; email?: string; isAdmin?: boolean },
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
    });
    // The verdict is the report's own type, not a second copy inside helpContext.
    expect(reports[0].type).toBe('Thumbs Down');
    expect(reports[0].helpContext).not.toHaveProperty('rating');

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
    // The rating can flip mid-edit, so the report's own verdict has to follow it.
    expect(reports[0].type).toBe('Thumbs Down');

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
    // The rating lives on the event, not in this request - the verdict write has to read it there.
    expect(reports[0].type).toBe('Thumbs Up');
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
    });
    expect(report?.type).toBe('Thumbs Down');
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

  /**
   * The chat half of the same fallback. `stitchRoutedComments` takes the two groups separately and
   * maps each inline, so the article group passing is no evidence about the chat one - a mapper
   * applied to only the first list would still render every article comment correctly.
   */
  it('still reads back a chat comment written before the split', async () => {
    const user = await makeUser();
    await HelpEventModel.create({
      type: 'chat_feedback',
      userId: user.id,
      chatQuestion: 'how do I export?',
      chatAnswer: 'use the export button',
      rating: 'not_helpful',
      comment: 'the button is not there',
    });

    const res = await call(myFeedbackHandler, 'GET', user);
    const body = res._getJSONData();

    expect(body.chatFeedback[0].comment).toBe('the button is not there');
  });

  /**
   * 201 vs 200 is how the client tells "this opened a new help event" from "this revised the one
   * already open", and both routes answer it off the same dedup read the router keys on.
   */
  it('answers 201 on a first submission and 200 on a revision, on both surfaces', async () => {
    const user = await makeUser();
    const chat = { chatQuestion: 'q', chatAnswer: 'a' };

    expect(
      (await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'first' }))._getStatusCode()
    ).toBe(201);
    expect(
      (await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'second' }))._getStatusCode()
    ).toBe(200);
    expect(
      (await call(chatHandler, 'POST', user, { ...chat, rating: 'helpful', comment: 'first' }))._getStatusCode()
    ).toBe(201);
    expect(
      (await call(chatHandler, 'POST', user, { ...chat, rating: 'helpful', comment: 'second' }))._getStatusCode()
    ).toBe(200);
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
  /**
   * The outdated flag has the same two submission sites the thumbs do: `useArticleFeedbackState`
   * sends `rating` + `reportType` with no comment when a reader ticks the box after writing their
   * note, which takes the verdict-sync branch rather than the router. Without the carry-over the
   * permanent report keeps saying the article was fine while the (expiring) event says otherwise.
   */
  it('carries an outdated flag raised after the comment onto the routed report', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'steps are stale' });
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', reportType: 'outdated' });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].helpContext?.reportType).toBe('outdated');
    // The note the flag was raised against is untouched by it.
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('steps are stale');
  });

  /**
   * `organizationId` is the authorization key a scoped reader filters these reports on, so the
   * router re-deriving it from the submitter's User row is a correctness property, not a display
   * detail - a report that lands with a null org is invisible to the org admins who should triage
   * it. Every other test here uses a user with no organization, which exercises only the fallback.
   */
  it('derives the submitter organization onto the routed report', async () => {
    const org = await Organization.create({ name: 'Acme Health', userId: 'owner-1' });
    const user = await User.create({
      username: 'org-user',
      name: 'Org User',
      email: 'org-user@example.com',
      organizationId: org._id,
    });

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'scoped note' });

    const report = await FeedbackModel.findOne({}).lean();
    expect(report?.organization).toBe('Acme Health');
    expect(String(report?.organizationId)).toBe(String(org._id));
  });

  it('records no organization for a submitter who belongs to none', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'unaffiliated' });

    const report = await FeedbackModel.findOne({}).lean();
    expect(report?.organization).toBe('Unknown');
    expect(report?.organizationId).toBeNull();
  });

  /**
   * `username` is required by the schema, so the fallback chain is what keeps a session missing a
   * display field from failing an otherwise valid report outright.
   */
  it('falls back to the email, then the user id, when a session carries no username', async () => {
    const emailOnly = await User.create({ username: 'e', name: 'E', email: 'email-only@example.com' });
    const idOnly = await User.create({ username: 'i', name: 'I', email: 'id-only@example.com' });

    await call(
      articleHandler,
      'POST',
      { id: emailOnly.id, email: 'email-only@example.com' },
      { slug: 'a', rating: 'helpful', comment: 'no username here' }
    );
    await call(articleHandler, 'POST', { id: idOnly.id }, { slug: 'b', rating: 'helpful', comment: 'neither here' });

    const byUser = new Map((await FeedbackModel.find({}).lean()).map(report => [report.userId, report.username]));
    expect(byUser.get(emailOnly.id)).toBe('email-only@example.com');
    expect(byUser.get(idOnly.id)).toBe(idOnly.id);
  });

  /**
   * The outcome assertion in 'revises the one report...' above also passes if `expiresAt` moves
   * from `$setOnInsert` into `$set`, because the schema marks the field immutable and mongoose
   * strips it before it reaches Mongo. That makes the outcome test unable to fail for the
   * mechanism it names, so the mechanism is pinned directly here.
   */
  it('revises the sibling text without writing expiresAt or upserting one back', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'first draft' });

    const updateSpy = vi.spyOn(FeedbackTextModel, 'updateOne');
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'revised text' });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    const [, update, options] = updateSpy.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
      { upsert?: boolean } | undefined,
    ];
    // Asserted on the update itself because the outcome is reachable two ways: not re-stamping
    // expiresAt, and not re-inserting a row that would carry a fresh one.
    expect(JSON.stringify(update)).not.toContain('expiresAt');
    expect(options?.upsert).not.toBe(true);
  });

  /**
   * The other writer of this collection refuses the same insert for the same stated reason
   * (`pages/api/feedback/[id]/update.ts`): `expiresAt` is immutable, so a swept sibling that gets
   * re-inserted comes back with a window minted from now - the retention extension the whole
   * permanent/TTL split exists to make impossible. Both writers have to agree or retention
   * depends on which path the caller took.
   */
  it('does not resurrect a text sibling the TTL already swept', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'first draft' });
    const report = await FeedbackModel.findOne({}).lean();
    await FeedbackTextModel.deleteOne({ _id: report!._id });

    const res = await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'revised text' });

    expect(res._getStatusCode()).toBeLessThan(400);
    expect(await FeedbackTextModel.countDocuments({})).toBe(0);
    // The permanent report survives and still reports that it once carried text.
    const after = await FeedbackModel.findOne({}).lean();
    expect(after?.contentStored).toBe(true);
  });

  /**
   * The text sibling is written before the report it belongs to, so a failed save has to take it
   * back out - otherwise a user's words sit in the store for 90 days with no report pointing at
   * them, unreadable by every surface and unattributable to anyone.
   */
  it('deletes the orphaned text sibling when the report itself fails to save', async () => {
    const user = await makeUser();
    const saveSpy = vi
      .spyOn(FeedbackModel.prototype, 'save')
      .mockRejectedValueOnce(new Error('feedback store unavailable') as never);

    const res = await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'orphan?' });

    expect(saveSpy).toHaveBeenCalled();
    // The original save error surfaces rather than being masked by the cleanup.
    expect(res._getStatusCode()).toBeGreaterThanOrEqual(500);
    expect(await FeedbackModel.countDocuments({})).toBe(0);
    expect(await FeedbackTextModel.countDocuments({})).toBe(0);
    saveSpy.mockRestore();
  });

  /**
   * The cleanup is best-effort on purpose: if it fails too, the caller still has to see the
   * ORIGINAL save error. Rethrowing the cleanup error instead would report "could not delete a
   * text row" for a submission that actually failed to save, and send whoever reads the log
   * looking in the wrong collection.
   */
  it('surfaces the save error, not the cleanup error, when the rollback fails too', async () => {
    const saveError = new Error('feedback store unavailable');
    const feedback = new FeedbackModel({ userId: 'u1', status: 'New', username: 'u', subject: 'help' });
    vi.spyOn(feedback, 'save').mockRejectedValueOnce(saveError as never);
    const deleteSpy = vi
      .spyOn(FeedbackTextModel, 'deleteOne')
      .mockRejectedValueOnce(new Error('text store unavailable') as never);
    const logger = stubLogger();

    await expect(
      saveFeedbackOrRollbackText({
        feedback,
        contentStored: true,
        logger: logger as Parameters<typeof saveFeedbackOrRollbackText>[0]['logger'],
      })
    ).rejects.toBe(saveError);

    expect(deleteSpy).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to delete orphaned FeedbackText sibling after a failed save',
      expect.objectContaining({ message: 'text store unavailable' })
    );
    deleteSpy.mockRestore();
  });

  /**
   * `my-feedback` passes `{ userId }` into the read, but its own query already limits the event
   * ids it hands over, so removing that argument leaves the round-trip tests green. The filter is
   * asserted here instead, against a call that deliberately passes both users' events in.
   */
  it('scopes the routed-comment read to the requesting user', async () => {
    const mine = await makeUser();
    const theirs = await User.create({ username: 'other', name: 'Other', email: 'other@example.com' });

    await call(articleHandler, 'POST', mine, { slug: 'shared', rating: 'helpful', comment: 'my note' });
    await call(articleHandler, 'POST', theirs, { slug: 'shared', rating: 'helpful', comment: 'their note' });

    const events = await HelpEventModel.find({ type: 'article_feedback' }).lean();
    expect(events).toHaveLength(2);

    const [scoped] = await stitchRoutedComments([events, []], { userId: mine.id });
    expect(scoped.map(event => event.comment).filter(Boolean)).toEqual(['my note']);

    // The admin surface omits the scope on purpose and relies on its own permission check.
    const [unscoped] = await stitchRoutedComments([events, []]);
    expect(unscoped.map(event => event.comment).sort()).toEqual(['my note', 'their note']);
  });
  /**
   * A revision writes `contentStored` and the verdict, and nothing else. Writing the whole
   * `helpContext` subdocument from the request instead would take the absent keys with it - and
   * `reportType` is exactly the key a revision arrives without, since the handler only ever $sets
   * the flag when the submission carries it - so the outdated chip the admin list renders would
   * silently disappear on the user's next edit.
   */
  it('keeps a stored flag that the revising submission does not carry', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, {
      slug: 'a',
      rating: 'not_helpful',
      reportType: 'outdated',
      comment: 'first note',
    });
    expect((await FeedbackModel.findOne({}).lean())?.helpContext?.reportType).toBe('outdated');

    // The stored outcome alone cannot say the revision behaved: the trailing sync re-reads
    // `reportType` off the event and writes it back, so a build that replaced the whole
    // `helpContext` subdocument would be repaired before anything below could see it. Capture the
    // revision's own update and assert on that instead.
    const updates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }> = [];
    const realUpdateOne = FeedbackModel.updateOne.bind(FeedbackModel);
    vi.spyOn(FeedbackModel, 'updateOne').mockImplementation((async (
      ...args: Parameters<typeof FeedbackModel.updateOne>
    ) => {
      updates.push({
        filter: args[0] as Record<string, unknown>,
        update: args[1] as Record<string, unknown>,
      });
      return realUpdateOne(...args);
    }) as never);

    // The revision the widget actually sends once the reader clears the checkbox: no reportType at
    // all. The flag stays on the event, so it has to stay on the report.
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'second note' });

    // The revision is the one keyed by `_id`; the trailing sync keys on the event instead.
    const revision = updates.find(entry => '_id' in entry.filter);
    expect(revision).toBeDefined();
    expect(Object.keys(revision!.update.$set as Record<string, unknown>)).toEqual(['contentStored']);

    const after = await FeedbackModel.findOne({}).lean();
    expect(after?.helpContext?.reportType).toBe('outdated');
    const text = await FeedbackTextModel.findById(after!._id).lean();
    expect(text?.content).toBe('second note');
  });

  /**
   * The thumbs stay clickable while a note submit is in flight, so a concurrent flip can land in
   * the middle of a revision. The revising request arrived carrying the OLD thumb (the widget
   * always posts its current rating alongside the note), so a verdict derived from that request
   * would put the report back on the verdict the reader just moved away from. Reading the event at
   * write time is what makes the last write the last read.
   *
   * Only the flip's EVENT write is injected, not its own `syncRoutedVerdict`. That is a real
   * interleave - the thumb handler issues those as two separate round trips
   * (`api/help/feedback.ts`), so a revision can land between them - and it is the one that leaves
   * the revision's trailing sync as the only thing that can move the report. Replaying the flip's
   * sync as well would reach the assertion with the report already correct, and the test would
   * then pass against a build with that trailing sync deleted.
   *
   * Driven through the real handler on purpose: a direct router call cannot carry the rating the
   * handlers always send, which is the whole shape under test.
   */
  it('does not revert a thumb flipped mid-revision, even though the request carries the old one', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'first note' });
    const report = await FeedbackModel.findOne({}).lean();
    const eventId = report!.helpContext!.eventId;
    expect(report?.type).toBe('Thumbs Down');

    // Deterministic interleave: the revise path writes the text sibling before it writes the
    // verdict, so landing the flip inside that call puts it exactly in the window the race occupies.
    const realUpdateOne = FeedbackTextModel.updateOne.bind(FeedbackTextModel);
    vi.spyOn(FeedbackTextModel, 'updateOne').mockImplementationOnce((async (
      ...args: Parameters<typeof FeedbackTextModel.updateOne>
    ) => {
      const result = await realUpdateOne(...args);
      await HelpEventModel.findOneAndUpdate({ _id: eventId }, { $set: { rating: 'helpful' } });
      return result;
    }) as never);

    // The report still says what it said before the flip, so nothing but the revision's own
    // trailing sync can bring it in line with the event.
    expect((await FeedbackModel.findOne({}).lean())?.type).toBe('Thumbs Down');

    // Still posting 'not_helpful': this is the reader's stale client state, which is exactly what
    // made the old snapshot path revert the flip.
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'second note' });

    const after = await FeedbackModel.findOne({}).lean();
    expect(after?.type).toBe('Thumbs Up');
    const text = await FeedbackTextModel.findById(after!._id).lean();
    expect(text?.content).toBe('second note');
  });

  /**
   * The same flip landing during the FIRST submission has no report to update - the sync is
   * update-only by design - so it matches nothing and is dropped. Without the re-sync after the
   * insert, that one flip is the only one that never reaches the permanent report.
   */
  it('picks up a thumb flipped while the first submission was still inserting', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful' });
    const event = await HelpEventModel.findOne({ type: 'article_feedback' }).lean();

    // Injected at the save itself, which is the only window that isolates the re-sync: the create
    // path reads the verdict just BEFORE constructing the document, so a flip landing any earlier
    // would be picked up by that read and prove nothing about the re-sync afterwards. Here the read
    // has already happened and is stale, and the flip's own sync finds no report to update.
    const realSave = FeedbackModel.prototype.save;
    vi.spyOn(FeedbackModel.prototype, 'save').mockImplementationOnce(async function (
      this: mongoose.Document,
      ...args: unknown[]
    ) {
      await HelpEventModel.findOneAndUpdate({ _id: event!._id }, { $set: { rating: 'helpful' } });
      await syncRoutedVerdict({ eventId: String(event!._id), userId: user.id });
      return (realSave as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    } as never);

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'first note' });

    const after = await FeedbackModel.findOne({}).lean();
    expect(after?.type).toBe('Thumbs Up');
    expect((await FeedbackTextModel.findById(after!._id).lean())?.content).toBe('first note');
  });

  /**
   * Both handlers trim the comment before branching, and the trim is load-bearing rather than
   * cosmetic: an untrimmed whitespace note is truthy, so it would take the comment branch, be
   * dropped by the router's own blank guard, and leave the verdict sync unrun - the event would
   * take the new rating while the permanent report kept the old one.
   */
  it('syncs a flipped article rating submitted alongside a whitespace-only note', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'this is wrong' });

    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: '   \n  ' });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('Thumbs Up');
    // The blank submission must not overwrite the note the user actually wrote.
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('this is wrong');
  });

  it('syncs a flipped chat rating submitted alongside a whitespace-only note', async () => {
    const user = await makeUser();
    const chat = { chatQuestion: 'q', chatAnswer: 'a' };
    await call(chatHandler, 'POST', user, { ...chat, rating: 'helpful', comment: 'actually incomplete' });

    await call(chatHandler, 'POST', user, { ...chat, rating: 'not_helpful', comment: '\t \n' });

    const reports = await FeedbackModel.find({}).lean();
    expect(reports).toHaveLength(1);
    expect(reports[0].type).toBe('Thumbs Down');
    const text = await FeedbackTextModel.findById(reports[0]._id).lean();
    expect(text?.content).toBe('actually incomplete');
  });

  /**
   * `readEventVerdict` is a round trip, so it can fail. It runs before the text sibling is written
   * for exactly that reason: a rejection after that write would answer 500 with a `FeedbackText`
   * row nothing points at, which is the one state `feedbackText.ts` promises cannot happen.
   */
  it('writes no text sibling when the verdict read fails', async () => {
    const user = await makeUser();
    vi.spyOn(HelpEventModel, 'findById').mockReturnValueOnce({
      select: () => ({ lean: () => Promise.reject(new Error('verdict read failed')) }),
    } as never);

    const res = await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'orphan me' });

    expect(res._getStatusCode()).toBe(500);
    expect(await FeedbackModel.countDocuments({})).toBe(0);
    expect(await FeedbackTextModel.countDocuments({})).toBe(0);
  });

  /**
   * The one shape that reaches `feedbackTypeForRating(undefined)`: a reader who writes a note
   * without touching the thumbs. It is a real report and has to triage as plain feedback rather
   * than inheriting a verdict nobody gave.
   */
  it('routes a comment left without a rating as plain feedback', async () => {
    const user = await makeUser();

    await call(articleHandler, 'POST', user, { slug: 'a', comment: 'no thumb, just a note' });

    const report = await FeedbackModel.findOne({}).lean();
    expect(report?.type).toBe(FeedbackType.FEEDBACK);
    const text = await FeedbackTextModel.findById(report!._id).lean();
    expect(text?.content).toBe('no thumb, just a note');
  });

  /**
   * The handlers only call the router when their own `writtenComment` is non-blank, so the
   * handler-driven whitespace test above never reaches the router's guard. Called directly, which
   * is what binds it: the router is exported and a second caller would arrive without that filter.
   */
  it('creates nothing for a blank comment handed straight to the router', async () => {
    const user = await makeUser();
    const event = await HelpEventModel.create({ type: 'article_feedback', userId: user.id, slug: 'a' });
    const logger = stubLogger();

    await routeHelpCommentToFeedback({
      submitter: { id: user.id, username: user.username, email: user.email },
      comment: '   \n\t ',
      helpContext: { eventId: event.id, surface: 'article', slug: 'a' },
      logger: logger as Parameters<typeof routeHelpCommentToFeedback>[0]['logger'],
    });

    expect(await FeedbackModel.countDocuments({})).toBe(0);
    expect(await FeedbackTextModel.countDocuments({})).toBe(0);
  });

  /**
   * Pins the residual window `syncRoutedVerdict` documents rather than leaving it to be rediscovered
   * as a bug. Its read and its write are two round trips, so a flip landing between them is still
   * lost - the fix upstream shrank the window to this, it did not close it. If this ever starts
   * failing, the guarantee got stronger (a version stamp on the help event would do it) and the
   * docstring at `syncRoutedVerdict` needs to say so.
   */
  it('still loses a flip that lands inside the sync read-to-write window', async () => {
    const user = await makeUser();
    await call(articleHandler, 'POST', user, { slug: 'a', rating: 'not_helpful', comment: 'a note' });
    const eventId = (await FeedbackModel.findOne({}).lean())!.helpContext!.eventId;

    // Between the sync's own read and its own write - the only gap left.
    const realUpdateOne = FeedbackModel.updateOne.bind(FeedbackModel);
    vi.spyOn(FeedbackModel, 'updateOne').mockImplementationOnce((async (
      ...args: Parameters<typeof FeedbackModel.updateOne>
    ) => {
      await HelpEventModel.findOneAndUpdate({ _id: eventId }, { $set: { rating: 'helpful' } });
      return realUpdateOne(...args);
    }) as never);

    await syncRoutedVerdict({ eventId, userId: user.id });

    // The accepted loss, stated: the event moved on and the report did not.
    expect((await HelpEventModel.findById(eventId).lean())?.rating).toBe('helpful');
    expect((await FeedbackModel.findOne({}).lean())?.type).toBe('Thumbs Down');
  });

  /**
   * The "collapses two concurrent submissions" test above asserts outcomes that hold whichever way
   * the two calls interleave - through the catch, or serialized through the `existing` revise -
   * so it cannot say the E11000 recovery actually ran. These two force the loser's path directly:
   * a first read that misses, then a save rejected with a duplicate-key error.
   */
  describe('losing the insert race', () => {
    const duplicateKeyError = () => Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

    const routeAs = (user: { id: string; username?: string; email?: string }, eventId: string, comment: string) => {
      const logger = stubLogger();
      return {
        logger,
        run: routeHelpCommentToFeedback({
          submitter: { id: user.id, username: user.username, email: user.email },
          comment,
          helpContext: { eventId, surface: 'article', slug: 'a' },
          logger: logger as Parameters<typeof routeHelpCommentToFeedback>[0]['logger'],
        }),
      };
    };

    it('revises the winner rather than stacking a second report', async () => {
      const user = await makeUser();
      await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful', comment: 'the winner' });
      const winner = await FeedbackModel.findOne({}).lean();

      // The miss is what puts this call on the insert path at all; the rejection is the index
      // refusing it. Both are one-shot, so the recovery read below runs against the real store.
      vi.spyOn(FeedbackModel, 'findOne').mockReturnValueOnce(Promise.resolve(null) as never);
      vi.spyOn(FeedbackModel.prototype, 'save').mockRejectedValueOnce(duplicateKeyError() as never);

      const { logger, run } = routeAs(user, winner!.helpContext!.eventId, 'the loser');
      await run;

      // Logged precisely so this branch can be told apart from "the race never happened".
      expect(logger.warn).toHaveBeenCalled();
      expect(await FeedbackModel.countDocuments({})).toBe(1);
      const text = await FeedbackTextModel.findById(winner!._id).lean();
      expect(text?.content).toBe('the loser');
      // The loser's own sibling was rolled back by the failed save, not stranded under the TTL.
      expect(await FeedbackTextModel.countDocuments({})).toBe(1);
    });

    it('rethrows when the winner it lost to cannot be read back', async () => {
      const user = await makeUser();
      await call(articleHandler, 'POST', user, { slug: 'a', rating: 'helpful' });
      const event = await HelpEventModel.findOne({}).lean();

      // Both reads miss, so there is no row to revise onto. Swallowing here would answer success
      // for a comment that reached neither store.
      vi.spyOn(FeedbackModel, 'findOne').mockReturnValue(Promise.resolve(null) as never);
      vi.spyOn(FeedbackModel.prototype, 'save').mockRejectedValueOnce(duplicateKeyError() as never);

      const { run } = routeAs(user, event!._id.toString(), 'goes nowhere');
      await expect(run).rejects.toThrow(/E11000/);

      expect(await FeedbackTextModel.countDocuments({})).toBe(0);
    });
  });
});
