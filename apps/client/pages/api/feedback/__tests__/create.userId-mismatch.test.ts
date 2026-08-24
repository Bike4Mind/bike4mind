import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, User, UserActivityCounter, Organization, CounterLog } from '@bike4mind/database';
import { FeedbackEvents } from '@bike4mind/common';
import errorHandler from '@server/middlewares/errorHandler';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * End-to-end regression test for the real chain: POST handler -> logEvent -> incrementUserCounter
 * -> User.findById. Deliberately does NOT mock @server/utils/analyticsLog or the database models,
 * because a mock would hide the real Mongoose CastError this bug produces -- the handler must
 * pass logEvent the same resolved id it already used to build the saved document, not the raw,
 * client-controlled request-body userId.
 */

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    get: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const mockPostFeedbackToSlack = vi.fn().mockResolvedValue({ outcome: 'delivered' });
vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: (...args: unknown[]) => mockPostFeedbackToSlack(...args),
}));

const mockEmailPublish = vi.fn().mockResolvedValue(undefined);
vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: (...args: unknown[]) => mockEmailPublish(...args) } },
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getSettingsMap: vi.fn().mockResolvedValue({}),
    // Slack and email both enabled so the identity-resolution fix in each egress block is actually
    // exercised -- with both off, neither block ran and the resolved-identity substitutions had no
    // coverage at all. FeedbackReceiveEmailNonProd is also set: this suite's real Config.STAGE is
    // 'test' (vitest.setup.ts), which classifies as non-production, and this test's own concern is
    // identity resolution reaching the email body, not stage routing (covered separately).
    getSettingsValue: vi.fn((key: string) =>
      key === 'EnableFeedBackToSlack'
        ? true
        : key === 'EnableFeedBackToEmail'
          ? true
          : key === 'FeedbackReceiveEmail' || key === 'FeedbackReceiveEmailNonProd'
            ? 'ops@example.com'
            : undefined
    ),
  };
});

import '../index';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

// Mirrors the real onError wiring in baseApi's next-connect router (errorHandler is the router's
// onError), so a thrown CastError is asserted as the actual 404 HTTP response the app would send,
// not just an uncaught rejection -- this test bypasses baseApi's real router entirely.
const runHandler = async (req: unknown, res: unknown) => {
  try {
    await mockRefs.postHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
};

describe('POST /api/feedback - authenticated caller with a mismatched body userId', () => {
  it('saves the feedback and returns 201, not a 404 from the analytics side-effect', async () => {
    const realUser = await User.create({
      username: 'e2e-feedback-user',
      name: 'Feedback User',
      email: 'feedback-user@example.com',
    });

    const { req, res } = createMocks({
      method: 'POST',
      body: {
        // Deliberately not the authenticated user's real id -- a client-controlled value that
        // isn't a valid ObjectId, exactly what an untrusted body field can carry.
        userId: 'not-a-valid-objectid',
        content: 'it broke',
        tags: [],
        username: 'reporter',
        userEmail: 'reporter@example.com',
      },
    });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    (req as unknown as { user: { id: string; username: string; email: string } }).user = {
      id: realUser.id,
      username: realUser.username,
      email: realUser.email,
    };
    (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
    (req as unknown as { logger: unknown }).logger = stubLogger();
    (req as unknown as { requestId: string }).requestId = 'test-request-id';

    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ content: 'it broke' });
    expect(saved).not.toBeNull();
    // The saved document and the analytics call must agree on the same resolved id -- the
    // authenticated user's real id, not the untrusted body value.
    expect(saved!.userId).toBe(realUser.id);

    // A passing 201 alone doesn't prove logEvent actually ran under the resolved id -- deleting the
    // whole logEvent call would still pass the assertions above. Pin that the analytics write happened.
    const counter = await UserActivityCounter.findOne({
      userId: realUser.id,
      action: FeedbackEvents.CREATE_FEEDBACK,
    });
    expect(counter?.count).toBe(1);

    // The Slack identity fields (username/userEmail/userId) went through the same raw-vs-resolved
    // swap as logEvent -- pin that the resolved (authenticated) identity actually reached Slack,
    // not the raw body fields ('reporter' / 'reporter@example.com').
    // postFeedbackToSlack(type, organization, username, userEmail, userId, content, promptMeta)
    const [, , slackUsername, slackEmail, slackUserId] = mockPostFeedbackToSlack.mock.calls[0];
    expect(slackUsername).toBe(realUser.username);
    expect(slackEmail).toBe(realUser.email);
    expect(slackUserId).toBe(realUser.id);

    // Same identity substitution went into the notification email's HTML body -- pin that too,
    // not just the Slack half, since the two egress points share the same underlying fix.
    const emailBody = mockEmailPublish.mock.calls[0][0].body as string;
    expect(emailBody).toContain(realUser.username);
    expect(emailBody).toContain(realUser.id);
  });

  it('resolves organization from the authenticated identity, not a client-supplied decoy email', async () => {
    const realUser = await User.create({
      username: 'e2e-org-user',
      name: 'Org User',
      email: 'org-user@example.com',
    });
    const realOrg = await Organization.create({ name: 'Real Org', userId: realUser.id });
    await User.findByIdAndUpdate(realUser.id, { organizationId: realOrg._id });

    const decoyUser = await User.create({
      username: 'decoy-user',
      name: 'Decoy User',
      email: 'decoy-user@example.com',
    });
    const decoyOrg = await Organization.create({ name: 'Decoy Org', userId: decoyUser.id });
    await User.findByIdAndUpdate(decoyUser.id, { organizationId: decoyOrg._id });

    const { req, res } = createMocks({
      method: 'POST',
      body: {
        userId: realUser.id,
        content: 'org mismatch check',
        tags: [],
        username: 'reporter',
        // A client-controlled value that happens to belong to a DIFFERENT account/org than the
        // authenticated caller -- the org lookup must not be keyed off this.
        userEmail: decoyUser.email,
      },
    });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    (req as unknown as { user: { id: string; username: string; email: string } }).user = {
      id: realUser.id,
      username: realUser.username,
      email: realUser.email,
    };
    (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
    (req as unknown as { logger: unknown }).logger = stubLogger();
    (req as unknown as { requestId: string }).requestId = 'test-request-id';

    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ content: 'org mismatch check' });
    expect(saved!.organization).toBe('Real Org');
  });

  it('still returns 201 with the feedback saved when the email notification fails', async () => {
    // Not Slack: postFeedbackToSlack wraps its entire body and never rejects (slack.ts), so it needs
    // no containment at the call site. EmailEvents.Send.publish goes straight to eventBridge.send
    // with no internal catch (eventBus.ts) -- that is the side-effect that can genuinely fail.
    mockEmailPublish.mockRejectedValueOnce(new Error('EventBridge is down'));

    const realUser = await User.create({
      username: 'e2e-email-failure-user',
      name: 'Email Failure User',
      email: 'email-failure-user@example.com',
    });

    const { req, res } = createMocks({
      method: 'POST',
      body: {
        userId: realUser.id,
        content: 'email outage should not mask this save',
        tags: [],
        username: 'reporter',
        userEmail: 'reporter@example.com',
      },
    });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    (req as unknown as { user: { id: string; username: string; email: string } }).user = {
      id: realUser.id,
      username: realUser.username,
      email: realUser.email,
    };
    (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
    (req as unknown as { logger: unknown }).logger = stubLogger();
    (req as unknown as { requestId: string }).requestId = 'test-request-id';

    await runHandler(req, res);

    // An email/EventBridge outage is a notification side-effect on an already-saved record, not
    // part of the write's contract -- it must not turn a successful save into a 5xx that prompts a
    // duplicate retry.
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ content: 'email outage should not mask this save' });
    expect(saved).not.toBeNull();
  });

  it('still returns 201 with the feedback saved when the analytics write fails', async () => {
    // A faithful stand-in for a transient Mongo failure on the second analytics write, strictly
    // after newFeedback.save() has already committed -- the masked-save shape the ticket is about,
    // just via a different trigger than the original CastError.
    const createSpy = vi.spyOn(CounterLog, 'create').mockRejectedValueOnce(new Error('connection timed out'));

    const realUser = await User.create({
      username: 'e2e-analytics-failure-user',
      name: 'Analytics Failure User',
      email: 'analytics-failure-user@example.com',
    });

    const { req, res } = createMocks({
      method: 'POST',
      body: {
        userId: realUser.id,
        content: 'analytics write failure should not mask this save',
        tags: [],
        username: 'reporter',
        userEmail: 'reporter@example.com',
      },
    });
    (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => true;
    (req as unknown as { user: { id: string; username: string; email: string } }).user = {
      id: realUser.id,
      username: realUser.username,
      email: realUser.email,
    };
    (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
    (req as unknown as { logger: unknown }).logger = stubLogger();
    (req as unknown as { requestId: string }).requestId = 'test-request-id';

    await runHandler(req, res);

    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ content: 'analytics write failure should not mask this save' });
    expect(saved).not.toBeNull();

    createSpy.mockRestore();
  });
});
