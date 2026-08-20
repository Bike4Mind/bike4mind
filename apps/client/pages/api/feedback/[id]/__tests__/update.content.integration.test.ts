import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { feedbackContentExpiresAt } from '@bike4mind/common';

/**
 * Real-Mongo functional coverage for the content-write paths in the update handler - the existing
 * update.test.ts only mocks the database, so it never proves the $unset/upsert-vs-update branching
 * actually behaves correctly against a real document. Deliberately does NOT mock @bike4mind/database.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

import '../update';

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

function mockRequest(id: string, body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'PUT', query: { id }, body });
  (req as unknown as { user: { id: string } }).user = { id: 'owner1' };
  (req as unknown as { ability: { can: () => boolean } }).ability = { can: () => true };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { req, res };
}

describe('PUT /api/feedback/[id] - content write paths (real Mongo)', () => {
  it('unsets a legacy content field on the permanent doc when originating a fresh sibling', async () => {
    // A pre-migration-shaped document: content still lives directly on it, contentStored is the
    // schema default (false), no sibling row exists yet.
    const doc = await FeedbackModel.create({
      userId: 'owner1',
      username: 'owner',
      status: 'New',
      content: 'legacy content still on the main document',
    });

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: 'edited content',
      username: 'owner',
      status: 'InProgress',
    });
    await mockRefs.putHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);

    const updated = await FeedbackModel.findById(doc.id).lean();
    expect(updated?.content).toBeUndefined();
    expect(updated?.contentStored).toBe(true);

    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling?.content).toBe('edited content');
  });

  it('unsets a legacy content field on the permanent doc when clearing it with an empty string', async () => {
    // Same pre-migration shape as the fresh-sibling test above, but this time the caller is
    // clearing the text outright rather than replacing it.
    const doc = await FeedbackModel.create({
      userId: 'owner1',
      username: 'owner',
      status: 'New',
      content: 'legacy content still on the main document',
    });

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: '',
      username: 'owner',
      status: 'InProgress',
    });
    await mockRefs.putHandler!(req, res);
    expect(res._getStatusCode()).toBe(200);

    const updated = await FeedbackModel.findById(doc.id).lean();
    expect(updated?.content).toBeUndefined();
    expect(updated?.contentStored).toBe(false);
  });

  it('updates the existing sibling in place when the document already has stored content', async () => {
    const doc = await FeedbackModel.create({
      userId: 'owner1',
      username: 'owner',
      status: 'New',
      contentStored: true,
    });
    await FeedbackTextModel.create({
      _id: doc._id,
      content: 'original content',
      expiresAt: feedbackContentExpiresAt(new Date()),
    });

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: 'updated content',
      username: 'owner',
      status: 'InProgress',
    });
    await mockRefs.putHandler!(req, res);

    expect(res._getJSONData().contentApplied).toBe(true);
    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling?.content).toBe('updated content');
  });

  it('signals contentApplied:false without resurrecting an expired sibling', async () => {
    const doc = await FeedbackModel.create({
      userId: 'owner1',
      username: 'owner',
      status: 'New',
      contentStored: true, // had content once; its sibling has since expired/been swept
    });

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: 'attempted edit on expired content',
      username: 'owner',
      status: 'InProgress',
    });
    await mockRefs.putHandler!(req, res);

    expect(res._getJSONData().contentApplied).toBe(false);
    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling).toBeNull();
  });

  it('leaves content untouched when the request omits it', async () => {
    const doc = await FeedbackModel.create({
      userId: 'owner1',
      username: 'owner',
      status: 'New',
      contentStored: true,
    });
    await FeedbackTextModel.create({
      _id: doc._id,
      content: 'untouched content',
      expiresAt: feedbackContentExpiresAt(new Date()),
    });

    const { req, res } = mockRequest(doc.id, { userId: 'owner1', username: 'owner', status: 'InProgress' });
    await mockRefs.putHandler!(req, res);

    expect(res._getJSONData().contentApplied).toBe(true);
    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling?.content).toBe('untouched content');
  });

  it('deletes the freshly-originated sibling if the document update then throws', async () => {
    const doc = await FeedbackModel.create({ userId: 'owner1', username: 'owner', status: 'New' });

    const updateSpy = vi.spyOn(FeedbackModel, 'findOneAndUpdate').mockRejectedValueOnce(new Error('write failed'));

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: 'should not survive',
      username: 'owner',
      status: 'InProgress',
    });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow('write failed');

    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling).toBeNull();

    updateSpy.mockRestore();
  });

  it('deletes the freshly-originated sibling if the document is gone by the time of the update', async () => {
    const doc = await FeedbackModel.create({ userId: 'owner1', username: 'owner', status: 'New' });

    // Simulates the delete race: the document existed for the initial findById/ability check but
    // is gone by the time findOneAndUpdate runs, so it returns null instead of throwing.
    const updateSpy = vi.spyOn(FeedbackModel, 'findOneAndUpdate').mockResolvedValueOnce(null);

    const { req, res } = mockRequest(doc.id, {
      userId: 'owner1',
      content: 'should not survive either',
      username: 'owner',
      status: 'InProgress',
    });
    await expect(mockRefs.putHandler!(req, res)).rejects.toThrow(/not found/i);

    const sibling = await FeedbackTextModel.findById(doc.id);
    expect(sibling).toBeNull();

    updateSpy.mockRestore();
  });
});
