import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, User } from '@bike4mind/database';

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

const mockPostFeedbackToSlack = vi.fn().mockResolvedValue(undefined);
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
    getSettingsValue: vi.fn(() => undefined),
  };
});

import '../index';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

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

    await mockRefs.postHandler!(req, res);

    expect(res._getStatusCode()).toBe(201);

    const saved = await FeedbackModel.findOne({ content: 'it broke' });
    expect(saved).not.toBeNull();
    // The saved document and the analytics call must agree on the same resolved id -- the
    // authenticated user's real id, not the untrusted body value.
    expect(saved!.userId).toBe(realUser.id);
  });
});
