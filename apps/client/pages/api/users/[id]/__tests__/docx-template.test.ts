import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { User } from '@bike4mind/database';
import { AppFile } from '@bike4mind/database/content';
import { AppFileReservedTags } from '@bike4mind/common';

/**
 * Real-DB regression tests for the DOCX template endpoint. Two concerns:
 *  - Setting a template on a user whose `preferences` field is still at its schema default of
 *    `null` (UserModel.ts): Mongo's dot-path $set cannot create a field inside a null parent
 *    ("Cannot create field 'docxTemplateFileId' in element {preferences: null}"), so this fails
 *    on any user who has never set a preference before - a mock of User.findByIdAndUpdate can't
 *    see this because it never runs a real Mongo update.
 *  - `docxTemplateFileId` used to be self-settable, so a stored id can point at a foreign file.
 *    GET must not leak that file's metadata, and DELETE must not strip its tag; both re-check
 *    ownership at the dereference and clear the stale preference.
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

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

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
});

function req(method: 'POST' | 'GET' | 'DELETE', userId: string, body?: unknown) {
  const { req, res } = createMocks({ method, query: { id: userId }, body });
  (req as unknown as { user: unknown }).user = { id: userId, isAdmin: false };
  return { req: req as never, res: res as never };
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function makeUser(name: string, preferences: unknown = null) {
  return User.create({ username: `${name}-u`, email: `${name}@test.com`, name, preferences });
}

async function makeFile(ownerId: string, tags: string[] = []) {
  return AppFile.create({
    userId: ownerId,
    name: `${ownerId}.docx`,
    size: 1000,
    path: `templates/${ownerId}.docx`,
    mimeType: DOCX_MIME,
    status: 'pending',
    tags,
  });
}

describe('POST /api/users/:id/docx-template - preferences defaults to null', () => {
  it('sets the template on a user whose preferences field is still null', async () => {
    const user = await makeUser('null-prefs', null);
    const file = await makeFile(user.id);

    const { req: r, res } = req('POST', user.id, { fileId: file.id });
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    const updated = await User.findById(user.id).select('preferences');
    expect(updated?.preferences?.docxTemplateFileId).toBe(file.id);
  });
});

describe('GET /api/users/:id/docx-template - foreign template id is not leaked', () => {
  it('returns template:null and clears the stale preference when the stored file is not owned', async () => {
    const owner = await makeUser('owner');
    const foreignFile = await makeFile(owner.id);
    const caller = await makeUser('caller', { docxTemplateFileId: foreignFile.id });

    const { req: r, res } = req('GET', caller.id);
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ template: null });
    // The foreign file's metadata never reaches the response, and the stale pref is cleared.
    const updated = await User.findById(caller.id).select('preferences');
    expect(updated?.preferences?.docxTemplateFileId).toBeFalsy();
  });

  it('returns the file details when the stored file is owned by the caller', async () => {
    const caller = await makeUser('caller');
    const ownFile = await makeFile(caller.id);
    await User.findByIdAndUpdate(caller.id, { $set: { preferences: { docxTemplateFileId: ownFile.id } } });

    const { req: r, res } = req('GET', caller.id);
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().template).toMatchObject({ fileId: ownFile.id, fileName: ownFile.name });
  });
});

describe('DELETE /api/users/:id/docx-template - foreign file tag is not stripped', () => {
  it('does not strip the DocxTemplate tag from a file the caller does not own', async () => {
    const owner = await makeUser('owner');
    const foreignFile = await makeFile(owner.id, [AppFileReservedTags.DocxTemplate]);
    const caller = await makeUser('caller', { docxTemplateFileId: foreignFile.id });

    const { req: r, res } = req('DELETE', caller.id);
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    // The foreign file keeps its DocxTemplate tag.
    const after = await AppFile.findById(foreignFile.id).select('tags');
    expect(after?.tags).toContain(AppFileReservedTags.DocxTemplate);
  });

  it('strips the DocxTemplate tag from the caller-owned file', async () => {
    const caller = await makeUser('caller');
    const ownFile = await makeFile(caller.id, [AppFileReservedTags.DocxTemplate]);
    await User.findByIdAndUpdate(caller.id, { $set: { preferences: { docxTemplateFileId: ownFile.id } } });

    const { req: r, res } = req('DELETE', caller.id);
    await handler(r, res);

    expect(res._getStatusCode()).toBe(200);
    const after = await AppFile.findById(ownFile.id).select('tags');
    expect(after?.tags).not.toContain(AppFileReservedTags.DocxTemplate);
  });
});
