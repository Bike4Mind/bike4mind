// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { KnowledgeType, attachOrgApiKeyReach } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';
import { FabFile, Project, Session, User } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The public project reads for an org-owned API key, against a real mongod and the real repositories
 * and services. The key's service account owns nothing and is in no group; its reach (what apiKeyAuth
 * attaches from the key's grants) is attached here directly. baseApi is stubbed (no auth chain), the
 * same harness as ../../__tests__/listGetParity.e2e.test.ts.
 */

vi.mock('@server/middlewares/baseApi', () => {
  type Mw = (req: unknown, res: unknown, next: () => void) => unknown;
  const compose =
    (...handlers: Mw[]) =>
    async (req: unknown, res: unknown) => {
      for (const handler of handlers) {
        let advanced = false;
        await handler(req, res, () => {
          advanced = true;
        });
        if (!advanced) return;
      }
    };
  return {
    methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
      res.status(405).end(),
    baseApi: () => ({ use: () => undefined, get: compose, post: compose, patch: compose, delete: compose }),
  };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/server-utils/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));

const ORG_ID = '65f000000000000000000001';
const SHARED_GROUP = '65f0000000000000000000a1';
const OTHER_GROUP = '65f0000000000000000000a2';

let mongoServer: MongoMemoryServer;
// any: the contract routers' param types carry prelude-only fields node-mocks-http lacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getHandler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let filesHandler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sessionsHandler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listCreateHandler: any;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  getHandler = (await import('../index')).default;
  filesHandler = (await import('../files/index')).default;
  sessionsHandler = (await import('../sessions/index')).default;
  listCreateHandler = (await import('../../index')).default;
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function call(handler: unknown, user: object, query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
  return res;
}

async function post(handler: unknown, user: object, body: Record<string, unknown>) {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user, logger });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
  return res;
}

async function seedAccounts() {
  const member = await User.create({ username: 'reach-member', name: 'Member', email: 'member@example.com' });
  const serviceAccount = await User.create({
    username: 'reach-svc',
    name: 'Service',
    email: 'svc@example.com',
    isSystem: true,
    serviceAccountOrganizationId: ORG_ID,
  });
  return { memberId: String(member.id), serviceAccountId: String(serviceAccount.id) };
}

/** The request user apiKeyAuth would hand the route for an org key reaching `readGroupIds`. */
const orgKeyUser = (serviceAccountId: string, readGroupIds: string[]) =>
  attachOrgApiKeyReach(
    { id: serviceAccountId, groups: [] as string[], isSystem: true, serviceAccountOrganizationId: ORG_ID },
    { organizationId: ORG_ID, readGroupIds, dataLakeOrgIds: [] }
  );

const groupShare = (groupId: string) => ({ groups: [{ groupId, permissions: ['read'] }] });

const file = (userId: string, name: string, extra: Record<string, unknown> = {}) =>
  FabFile.create({
    userId,
    fileName: name,
    mimeType: 'text/plain',
    type: KnowledgeType.FILE,
    filePath: name,
    moderationStatus: 'clean',
    ...extra,
  });

const notebook = (userId: string, extra: Record<string, unknown> = {}) =>
  Session.create({ name: 'n', userId, lastUpdated: new Date(), firstCreated: new Date(), ...extra });

describe('GET /api/v1/projects/{id} for an org-owned key', () => {
  it('reads a project shared with a granted group', async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const shared = await Project.create({ name: 'Shared', userId: memberId, ...groupShare(SHARED_GROUP) });

    const res = await call(getHandler, orgKeyUser(serviceAccountId, [SHARED_GROUP]), { id: String(shared.id) });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().id).toBe(String(shared.id));
  });

  it("answers 404 for a member's private project and one shared with an ungranted group", async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const privateProject = await Project.create({ name: 'Private', userId: memberId });
    const otherGroup = await Project.create({ name: 'Other', userId: memberId, ...groupShare(OTHER_GROUP) });
    const user = orgKeyUser(serviceAccountId, [SHARED_GROUP]);

    await expect(call(getHandler, user, { id: String(privateProject.id) })).rejects.toMatchObject({ statusCode: 404 });
    await expect(call(getHandler, user, { id: String(otherGroup.id) })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('answers 404 for a group-shared project when the key holds no grant', async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const shared = await Project.create({ name: 'Shared', userId: memberId, ...groupShare(SHARED_GROUP) });

    await expect(call(getHandler, orgKeyUser(serviceAccountId, []), { id: String(shared.id) })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('GET /api/v1/projects/{id}/(files|sessions) for an org-owned key', () => {
  it('lists only the files the key may read, not a member personal file attached to the project', async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const sharedFile = await file(memberId, 'shared.txt', groupShare(SHARED_GROUP));
    const personalFile = await file(memberId, 'personal.txt');
    const project = await Project.create({
      name: 'Shared',
      userId: memberId,
      fileIds: [String(sharedFile.id), String(personalFile.id)],
      ...groupShare(SHARED_GROUP),
    });

    const res = await call(filesHandler, orgKeyUser(serviceAccountId, [SHARED_GROUP]), { id: String(project.id) });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().data.map((row: { id: string }) => row.id)).toEqual([String(sharedFile.id)]);
  });

  it('lists only the notebooks the key may read', async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const sharedNotebook = await notebook(memberId, groupShare(SHARED_GROUP));
    const personalNotebook = await notebook(memberId);
    const project = await Project.create({
      name: 'Shared',
      userId: memberId,
      sessionIds: [String(sharedNotebook.id), String(personalNotebook.id)],
      ...groupShare(SHARED_GROUP),
    });

    const res = await call(sessionsHandler, orgKeyUser(serviceAccountId, [SHARED_GROUP]), { id: String(project.id) });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().data.map((row: { id: string }) => row.id)).toEqual([String(sharedNotebook.id)]);
  });

  it('still lists every item for a member reading the same project', async () => {
    const { memberId } = await seedAccounts();
    const sharedFile = await file(memberId, 'shared.txt', groupShare(SHARED_GROUP));
    const personalFile = await file(memberId, 'personal.txt');
    const project = await Project.create({
      name: 'Shared',
      userId: memberId,
      fileIds: [String(sharedFile.id), String(personalFile.id)],
    });

    const res = await call(filesHandler, { id: memberId, groups: [] }, { id: String(project.id) });

    expect(res._getStatusCode()).toBe(200);
    expect(
      res
        ._getJSONData()
        .data.map((row: { id: string }) => row.id)
        .sort()
    ).toEqual([String(sharedFile.id), String(personalFile.id)].sort());
  });
});

describe('GET /api/v1/projects/{id} item ids for an org-owned key', () => {
  it("omits a member's personal items attached to the shared project; a member still sees all", async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const sharedFile = await file(memberId, 'shared.txt', groupShare(SHARED_GROUP));
    const personalFile = await file(memberId, 'personal.txt');
    const sharedNotebook = await notebook(memberId, groupShare(SHARED_GROUP));
    const personalNotebook = await notebook(memberId);
    const project = await Project.create({
      name: 'Shared',
      userId: memberId,
      fileIds: [String(sharedFile.id), String(personalFile.id)],
      sessionIds: [String(sharedNotebook.id), String(personalNotebook.id)],
      ...groupShare(SHARED_GROUP),
    });

    const keyRes = await call(getHandler, orgKeyUser(serviceAccountId, [SHARED_GROUP]), { id: String(project.id) });
    expect(keyRes._getStatusCode()).toBe(200);
    expect(keyRes._getJSONData().file_ids).toEqual([String(sharedFile.id)]);
    expect(keyRes._getJSONData().session_ids).toEqual([String(sharedNotebook.id)]);

    const memberRes = await call(getHandler, { id: memberId, groups: [] }, { id: String(project.id) });
    expect(memberRes._getJSONData().file_ids.sort()).toEqual([String(sharedFile.id), String(personalFile.id)].sort());
    expect(memberRes._getJSONData().session_ids.sort()).toEqual(
      [String(sharedNotebook.id), String(personalNotebook.id)].sort()
    );
  });
});

describe('POST /api/v1/projects for an org-owned key', () => {
  it('refuses file_ids that are readable only through the granted group (400)', async () => {
    const { memberId, serviceAccountId } = await seedAccounts();
    const sharedFile = await file(memberId, 'shared.txt', groupShare(SHARED_GROUP));

    await expect(
      post(listCreateHandler, orgKeyUser(serviceAccountId, [SHARED_GROUP]), {
        name: 'Smuggle',
        description: 'd',
        file_ids: [String(sharedFile.id)],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await Project.countDocuments({ name: 'Smuggle' })).toBe(0);
  });
});
