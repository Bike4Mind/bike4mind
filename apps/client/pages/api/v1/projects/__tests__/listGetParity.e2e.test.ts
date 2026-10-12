// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Project, User } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * GET /api/v1/projects and GET /api/v1/projects/{id} against a real mongod and the real
 * repositories: every id the list pages out must come back 200 from get, and a project only
 * reachable through another owner's global-read flag (which get refuses) must not be listed.
 * baseApi is stubbed (no auth chain); the contract prelude and handlers are real.
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
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/userRateTier', () => ({ resolveUserRateLimitPerMin: () => 60 }));

let mongoServer: MongoMemoryServer;
// any: the contract routers' param types carry prelude-only fields node-mocks-http lacks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let listHandler: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getHandler: any;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  listHandler = (await import('../index')).default;
  getHandler = (await import('../[id]/index')).default;
});

// Retries rerun the body, so start each attempt from an empty database.
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Project.syncIndexes();
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

const project = (name: string, userId: string, extra: Record<string, unknown> = {}) =>
  Project.create({ name, description: `${name} description`, userId, sessionIds: [], fileIds: [], ...extra });

describe('/api/v1/projects list/get parity', () => {
  it('lists exactly the projects get resolves, across pages', async () => {
    // get re-reads the caller from the database, so the group membership has to live there too.
    const caller = await User.create({
      username: 'parity-caller',
      name: 'Caller',
      email: 'caller@example.com',
      groups: ['group-1'],
    });
    const other = await User.create({ username: 'parity-other', name: 'Other', email: 'other@example.com' });
    const user = { id: caller.id, groups: caller.groups };

    const expected = [
      await project('mine', caller.id),
      await project('mine-global', caller.id, { isGlobalRead: true }),
      await project('user-shared', other.id, { users: [{ userId: caller.id, permissions: ['read'] }] }),
      await project('group-shared', other.id, { groups: [{ groupId: 'group-1', permissions: ['read'] }] }),
    ].map(doc => String(doc.id));
    const globalOnly = String((await project('global-only', other.id, { isGlobalRead: true })).id);
    await project('foreign', other.id);

    const listed: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const res = await call(listHandler, user, { limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      listed.push(...body.data.map((row: { id: string }) => row.id));
      if (body.next_cursor === null) break;
      cursor = body.next_cursor;
    }

    expect([...listed].sort()).toEqual([...expected].sort());
    expect(listed).not.toContain(globalOnly);

    for (const id of listed) {
      const res = await call(getHandler, user, { id });
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().id).toBe(id);
    }
    await expect(call(getHandler, user, { id: globalOnly })).rejects.toMatchObject({ statusCode: 404 });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
