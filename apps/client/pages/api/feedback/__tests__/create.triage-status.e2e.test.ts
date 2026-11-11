import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { countNewFeedback, FeedbackModel } from '@bike4mind/database';
import {
  FeedbackStatus,
  FeedbackType,
  NO_FEEDBACK_DETAILS_PLACEHOLDER,
  WAITLIST_FEEDBACK_TAG,
} from '@bike4mind/common';
import errorHandler from '@server/middlewares/errorHandler';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: () => Chain; get: () => Chain; post: (fn: (req: unknown, res: unknown) => unknown) => Chain };
  const chain: Chain = {
    use: () => chain,
    get: () => chain,
    post: fn => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({
  postFeedbackToSlack: vi.fn().mockResolvedValue({ outcome: 'skipped', reason: 'disabled' }),
}));

vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  EmailEvents: { Send: { publish: vi.fn().mockResolvedValue(undefined) } },
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
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});

async function submit(body: { type?: string; content: string; tags?: string[] }) {
  const { req, res } = createMocks({
    method: 'POST',
    body: { userId: 'Unknown', username: 'someone', userEmail: 'someone@example.com', tags: [], ...body },
  });
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  Object.assign(req, {
    isAuthenticated: () => false,
    ability: { can: () => true },
    logger,
    requestId: 'test-request-id',
  });
  try {
    await mockRefs.postHandler!(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
  expect(res._getStatusCode()).toBe(201);
  const saved = await FeedbackModel.findById(JSON.parse(res._getData())._id).lean();
  return saved!.status;
}

describe('POST /api/feedback - initial triage status', () => {
  it('stores a thumbs-up with no comment as Closed, so it stays out of the New queue', async () => {
    expect(await submit({ type: FeedbackType.THUMBS_UP, content: '   ' })).toBe(FeedbackStatus.Closed);
    expect(await countNewFeedback()).toBe(0);
  });

  it('stores a thumbs-up from the bug-report modal with an empty comment as Closed', async () => {
    const status = await submit({ type: FeedbackType.THUMBS_UP, content: '', tags: ['bug', 'feedback', 'bugReport'] });
    expect(status).toBe(FeedbackStatus.Closed);
  });

  it('stores a thumbs-up carrying the legacy placeholder text as Closed', async () => {
    expect(await submit({ type: FeedbackType.THUMBS_UP, content: NO_FEEDBACK_DETAILS_PLACEHOLDER })).toBe(
      FeedbackStatus.Closed
    );
  });

  it('keeps a thumbs-up that carries a comment New', async () => {
    expect(await submit({ type: FeedbackType.THUMBS_UP, content: 'Great answer' })).toBe(FeedbackStatus.New);
  });

  it('keeps a comment-less thumbs-down New', async () => {
    expect(await submit({ type: FeedbackType.THUMBS_DOWN, content: '' })).toBe(FeedbackStatus.New);
  });

  it('keeps a typed report New even when it carries the waitlist tag', async () => {
    expect(await submit({ type: FeedbackType.BUG, content: 'It broke', tags: [WAITLIST_FEEDBACK_TAG] })).toBe(
      FeedbackStatus.New
    );
  });

  it('stores an untyped waitlist signup from a stale coming-soon client as Closed', async () => {
    const status = await submit({
      content: 'Coming soon signup',
      tags: [WAITLIST_FEEDBACK_TAG, 'marketing'],
    });
    expect(status).toBe(FeedbackStatus.Closed);
  });
});
