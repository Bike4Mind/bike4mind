import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';

/**
 * Real-DB regression test for setting a DOCX template on a user whose `preferences` field is
 * still at its schema default of `null` (UserModel.ts). Mongo's dot-path $set cannot create a
 * field inside a null parent ("Cannot create field 'docxTemplateFileId' in element
 * {preferences: null}"), so this fails on any user who has never set a preference before -
 * a mock of User.findByIdAndUpdate can't see this because it never runs a real Mongo update.
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'POST']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../docx-template';

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
});

function req(userId: string, body: unknown) {
  const { req, res } = createMocks({ method: 'POST', query: { id: userId }, body });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  return { req: req as never, res: res as never };
}

describe('POST /api/users/:id/docx-template - preferences defaults to null', () => {
  it('sets the template on a user whose preferences field is still null', async () => {
    const user = await User.create({
      username: 'nulluser',
      email: 'nulluser@test.com',
      name: 'Null Preferences User',
      preferences: null,
    });
    const file = await AppFile.create({
      userId: user.id,
      name: 'template.docx',
      size: 1000,
      path: 'templates/template.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      status: 'pending',
      tags: [],
    });

    const { req: r, res } = req(user.id, { fileId: file.id });
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    const updated = await User.findById(user.id).select('preferences');
    expect(updated?.preferences?.docxTemplateFileId).toBe(file.id);
  });
});
