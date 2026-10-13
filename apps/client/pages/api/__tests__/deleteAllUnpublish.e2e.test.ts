import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { KnowledgeType, Permission } from '@bike4mind/common';
import { FabFile, PublishedArtifact, User } from '@bike4mind/database';
import { Session } from '@bike4mind/database/auth';
import defineAbilitiesFor from '@server/auth/ability';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// DELETE /api/sessions and DELETE /api/files against a real database, then the public serve route:
// the caller's pages published from what they deleted must stop serving, and every other page
// (another user's publish of the same source, the caller's pages from sources that survive) must
// keep serving.

type Handler = (req: unknown, res: unknown) => unknown;

// Each module's handler is the chain itself, dispatched by method (last fn per verb wins).
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const verbs: Record<string, Handler> = {};
    const register =
      (verb: string) =>
      (...fns: Handler[]) => {
        verbs[verb] = fns[fns.length - 1];
        return chain;
      };
    const chain = Object.assign((req: { method?: string }, res: unknown) => verbs[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      get: register('GET'),
      post: register('POST'),
      delete: register('DELETE'),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/apiKeyAuth', () => ({
  apiKeyAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/optionalJwtAuth', () => ({
  optionalJwtAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/starterCredits', () => ({ getOpenSignupStarterCredits: () => Promise.resolve(0) }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ delete: vi.fn().mockResolvedValue(undefined) }),
  getPublishedArtifactsStorage: () => ({ download: vi.fn() }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/services/publish/invalidatePublishCdn', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/services/publish/invalidatePublishCdn')>()),
  invalidatePublishCdn: vi.fn().mockResolvedValue(undefined),
  invalidatePublishCdnMany: vi.fn().mockResolvedValue(undefined),
}));

let replSet: MongoMemoryReplSet;
let sessionsHandler: Handler;
let filesHandler: Handler;
let serveHandler: Handler;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri());
  sessionsHandler = (await import('../sessions/index')).default as unknown as Handler;
  filesHandler = (await import('../files/index')).default as unknown as Handler;
  serveHandler = (await import('../publish/serve/[...path]')).default as unknown as Handler;
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const createUser = (name: string) =>
  User.create({
    name,
    username: `${name}-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
  });

const createSession = (userId: string) =>
  Session.create({ name: 'Notebook', userId, lastUpdated: new Date(), firstCreated: new Date() });

const createFile = (userId: string, users: { userId: string; permissions: Permission[] }[] = []) =>
  FabFile.create({ userId, fileName: 'notes.md', type: KnowledgeType.FILE, mimeType: 'text/markdown', users });

let seq = 0;
const publish = (ownerId: string, source: Record<string, unknown>) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: ownerId,
    slug: `page-${seq}`,
    title: 'Page',
    ownerId,
    visibility: 'public',
    source,
    renderedBody: `body ${seq}`,
    storageKeyPrefix: '',
    manifest: [],
  });
};

const deleteAllAs = async (handler: Handler, user: InstanceType<typeof User>) => {
  const { req, res } = createMocks({ method: 'DELETE' });
  Object.assign(req, {
    user,
    ability: defineAbilitiesFor(user),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  });
  await handler(req, res);
  return res._getStatusCode();
};

const serveStatus = async (prefix: 'r' | 'f', publicId: string) => {
  const { req, res } = createMocks({
    method: 'GET',
    query: { path: [prefix, publicId] },
    headers: { host: 'app.bike4mind.com' },
  });
  await serveHandler(req, res);
  return res._getStatusCode();
};

describe('delete all notebooks takes down replies published from them', () => {
  it("takes down only the caller's pages from the deleted notebooks", async () => {
    const [caller, other] = await Promise.all([createUser('caller'), createUser('other')]);
    const [ownNotebook, othersNotebook] = await Promise.all([createSession(caller.id), createSession(other.id)]);

    const callersPage = await publish(caller.id, { kind: 'reply', sessionId: ownNotebook.id, messageId: 'm1' });
    const othersPageOfSameNotebook = await publish(other.id, {
      kind: 'reply',
      sessionId: ownNotebook.id,
      messageId: 'm1',
    });
    const callersPageOfSurvivingNotebook = await publish(caller.id, {
      kind: 'reply',
      sessionId: othersNotebook.id,
      messageId: 'm2',
    });
    const callersFilePage = await publish(caller.id, { kind: 'fabfile', fabFileId: ownNotebook.id });

    expect(await serveStatus('r', callersPage.publicId)).toBe(200);

    expect(await deleteAllAs(sessionsHandler, caller)).toBe(204);

    expect(await serveStatus('r', callersPage.publicId)).toBe(404);
    expect(await serveStatus('r', othersPageOfSameNotebook.publicId)).toBe(200);
    expect(await serveStatus('r', callersPageOfSurvivingNotebook.publicId)).toBe(200);
    // A file page whose id happens to equal a notebook id is matched on kind, not id alone.
    expect(await serveStatus('f', callersFilePage.publicId)).toBe(200);

    const takenDown = await PublishedArtifact.collection.findOne({ publicId: callersPage.publicId });
    expect(takenDown?.deletedAt).toBeInstanceOf(Date);
    expect(takenDown?.deletedBy).toBe(caller.id);
    expect((await Session.collection.findOne({ _id: ownNotebook._id }))?.deletedAt).toBeInstanceOf(Date);
  });
});

describe('delete all knowledge files takes down files published from them', () => {
  it("takes down only the caller's pages from the files they owned", async () => {
    const [caller, other] = await Promise.all([createUser('caller'), createUser('other')]);
    const ownFile = await createFile(caller.id);
    const sharedIn = await createFile(other.id, [
      { userId: caller.id, permissions: [Permission.read, Permission.delete] },
    ]);

    const callersPage = await publish(caller.id, { kind: 'fabfile', fabFileId: ownFile.id });
    const othersPageOfSameFile = await publish(other.id, { kind: 'fabfile', fabFileId: ownFile.id });
    const callersPageOfSharedFile = await publish(caller.id, { kind: 'fabfile', fabFileId: sharedIn.id });
    const othersPageOfSharedFile = await publish(other.id, { kind: 'fabfile', fabFileId: sharedIn.id });

    expect(await serveStatus('f', callersPage.publicId)).toBe(200);

    expect(await deleteAllAs(filesHandler, caller)).toBe(204);

    expect(await serveStatus('f', callersPage.publicId)).toBe(404);
    expect(await serveStatus('f', othersPageOfSameFile.publicId)).toBe(200);
    // A file shared IN is only unshared, so pages built from it stay up for everyone.
    expect(await serveStatus('f', callersPageOfSharedFile.publicId)).toBe(200);
    expect(await serveStatus('f', othersPageOfSharedFile.publicId)).toBe(200);
  });
});
