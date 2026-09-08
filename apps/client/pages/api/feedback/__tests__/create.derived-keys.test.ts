import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, FeedbackTextModel, User, Organization, Session, Quest } from '@bike4mind/database';
import errorHandler from '@server/middlewares/errorHandler';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Ground-truth regression test for the ticket's named acceptance criterion: a client cannot
 * spoof organizationId/questId onto a Feedback record by carrying a foreign value in promptMeta
 * or a top-level claim - both are re-derived server-side from the authenticated session and a
 * quest/session re-read. Deliberately does NOT mock @bike4mind/database or the create handler's
 * DB calls, since a mock would hide the real ownership check this fix depends on.
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

vi.mock('@server/integrations/slack/slack', () => ({
  postFeedbackToSlack: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'disabled' }),
}));

vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: vi.fn().mockResolvedValue(undefined) } },
}));

vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    getSettingsMap: vi.fn().mockResolvedValue({}),
    // Both channels off: this suite's concern is FK derivation, not delivery.
    getSettingsValue: vi.fn(() => undefined),
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

const runHandler = async (req: unknown, res: unknown) => {
  try {
    await mockRefs.postHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
};

function mockRequest(body: Record<string, unknown>, user?: { id: string; username: string; email: string }) {
  const { req, res } = createMocks({ method: 'POST', body });
  const authenticated = !!user;
  (req as unknown as { isAuthenticated: () => boolean }).isAuthenticated = () => authenticated;
  if (user) {
    (req as unknown as { user: typeof user }).user = user;
  }
  (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';
  return { req, res };
}

async function makeUserWithOrg(usernamePrefix: string) {
  const user = await User.create({
    username: `${usernamePrefix}-user`,
    name: `${usernamePrefix} User`,
    email: `${usernamePrefix}@example.com`,
  });
  const org = await Organization.create({ name: `${usernamePrefix} Org`, userId: user.id });
  await User.findByIdAndUpdate(user.id, { organizationId: org._id });
  return { user, org };
}

async function makeOwnedQuest(ownerId: string) {
  const session = await Session.create({
    name: 'a session',
    userId: ownerId,
    lastUpdated: new Date(),
    firstCreated: new Date(),
  });
  const quest = await Quest.create({
    sessionId: session.id,
    timestamp: new Date(),
    type: 'message',
    prompt: 'hello',
  });
  return { session, quest };
}

describe('POST /api/feedback - server-derived foreign keys', () => {
  it('derives organizationId from the authenticated session, not a forged promptMeta claim', async () => {
    const { user: userA, org: orgA } = await makeUserWithOrg('user-a');
    const { org: orgB } = await makeUserWithOrg('user-b-owner');
    const { quest: questB } = await makeOwnedQuest('some-other-user-id');

    const { req, res } = mockRequest(
      {
        userId: userA.id,
        content: 'the answer was wrong',
        tags: [],
        username: userA.username,
        userEmail: userA.email,
        questId: questB.id,
        promptMeta: {
          session: { id: 'whatever', userId: userA.id, organizationId: orgB._id.toString() },
          questId: questB.id,
        },
      },
      { id: userA.id, username: userA.username, email: userA.email }
    );

    await runHandler(req, res);
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ userId: userA.id });
    expect(saved).not.toBeNull();
    expect(String(saved!.organizationId)).toBe(String(orgA._id));
    expect(saved!.questId).toBeUndefined();
    expect(saved!.sessionId).toBeUndefined();
    expect(saved!.subject).toBe('product');
    // The forge is preserved in promptMeta (untrusted diagnostic snapshot), proving this is
    // derivation, not sanitization: the field was never read, not scrubbed after the fact.
    expect((saved!.promptMeta as { session?: { organizationId?: string } })?.session?.organizationId).toBe(
      orgB._id.toString()
    );
  });

  it('resolves questId/sessionId/subject for a quest the caller actually owns', async () => {
    const { user } = await makeUserWithOrg('owner');
    const { quest, session } = await makeOwnedQuest(user.id);

    const { req, res } = mockRequest(
      {
        userId: user.id,
        content: 'great answer',
        tags: [],
        username: user.username,
        userEmail: user.email,
        questId: quest.id,
        promptMeta: { session: { id: 'a-different-session-id-in-the-body', userId: user.id }, questId: quest.id },
      },
      { id: user.id, username: user.username, email: user.email }
    );

    await runHandler(req, res);
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ userId: user.id });
    expect(saved!.questId).toBe(quest.id);
    // sessionId is taken from the quest's own re-read, never from promptMeta.session.id.
    expect(saved!.sessionId).toBe(session.id);
    expect(saved!.subject).toBe('turn');
  });

  it('handles legacy/empty promptMeta shapes without throwing', async () => {
    const { user } = await makeUserWithOrg('legacy');

    for (const promptMeta of [undefined, {}, { session: { id: 's1', userId: user.id } }]) {
      const { req, res } = mockRequest(
        {
          userId: user.id,
          content: `report for ${JSON.stringify(promptMeta)}`,
          tags: [],
          username: user.username,
          userEmail: user.email,
          promptMeta,
        },
        { id: user.id, username: user.username, email: user.email }
      );

      await runHandler(req, res);
      expect(res._getStatusCode()).toBe(201);
    }
  });

  it('drops a junk (non-ObjectId) questId claim without a CastError-to-404', async () => {
    const { user } = await makeUserWithOrg('junk');

    const { req, res } = mockRequest(
      {
        userId: user.id,
        content: 'junk quest id',
        tags: [],
        username: user.username,
        userEmail: user.email,
        questId: 'not-an-objectid',
      },
      { id: user.id, username: user.username, email: user.email }
    );

    await runHandler(req, res);
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ userId: user.id });
    expect(saved!.questId).toBeUndefined();
  });

  it('keeps the display organization string unchanged but derives no organizationId for an unauthenticated submitter', async () => {
    const { user: orgBUser, org: orgB } = await makeUserWithOrg('unauth-org-b-member');

    const { req, res } = mockRequest({
      userId: 'client-supplied-id',
      content: 'anonymous report',
      tags: [],
      username: 'anon',
      // A real org-B member's email, supplied by an unauthenticated caller - the display string
      // may still resolve (unchanged, pre-existing behavior); the FK must not.
      userEmail: orgBUser.email,
    });

    await runHandler(req, res);
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ userEmail: orgBUser.email });
    expect(saved!.organization).toBe(orgB.name);
    expect(saved!.organizationId).toBeNull();
  });

  it('stores content in the FeedbackText sibling, not on the permanent document', async () => {
    const { user } = await makeUserWithOrg('retention');

    const { req, res } = mockRequest(
      {
        userId: user.id,
        content: 'this text should be split out',
        tags: [],
        username: user.username,
        userEmail: user.email,
      },
      { id: user.id, username: user.username, email: user.email }
    );

    await runHandler(req, res);
    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ userId: user.id });
    expect(saved!.content).toBeUndefined();
    expect(saved!.contentStored).toBe(true);

    const text = await FeedbackTextModel.findById(saved!._id);
    expect(text?.content).toBe('this text should be split out');
    expect(text?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
