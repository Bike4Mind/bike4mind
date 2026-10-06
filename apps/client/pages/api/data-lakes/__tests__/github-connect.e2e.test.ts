import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import {
  DataLakeModel,
  DataLakeAccessGrantModel,
  LakeConfigChangeEventModel,
  dataLakeAccessGrantRepository,
} from '@bike4mind/database';
import { GITHUB_LAKE_PLACEHOLDER_NAME, NotFoundError } from '@bike4mind/common';
import { nameLakeAfterRepository } from '@server/integrations/github/dataLake/githubLakeConnection';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * Drives the real handler through the real repositories, createDataLake and the lake indexes, so
 * "nothing is left behind" is a fact about Mongo rather than about which mocks were called. Mocks
 * stop at the org-access lookup, the App config, and the state-token signer.
 */

type Middleware = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

const h = vi.hoisted(() => ({
  flags: { EnableDataLakes: true, EnableDataLakeGitHub: true } as Record<string, boolean>,
  verifyOrgAccess: vi.fn(),
  getGitHubLakeAppConfig: vi.fn(),
  createStateToken: vi.fn(),
}));

// Runs the registered middlewares in order, so the flag gates are exercised rather than skipped.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Middleware[] = [];
    let post: (req: unknown, res: unknown) => unknown = () => undefined;
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const mw of middlewares) {
          let advanced = false;
          await mw(req, res, () => (advanced = true));
          if (!advanced) return;
        }
        return post(req, res);
      },
      {
        use: (mw: Middleware) => (middlewares.push(mw), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((post = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled:
    (flag: string): Middleware =>
    (_req, res, next) =>
      h.flags[flag] ? next() : (res as { status: (n: number) => { json: (b: unknown) => void } }).status(404).json({}),
}));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/integrations/github/dataLake/lakeAppClient', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/integrations/github/dataLake/lakeAppClient')>()),
  getGitHubLakeAppConfig: h.getGitHubLakeAppConfig,
}));
vi.mock('@server/auth/jwtStateStore', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/auth/jwtStateStore')>()),
  createStateToken: h.createStateToken,
}));

import handler, { createGitHubConnectHandler } from '../github-connect';

const ORG = 'org-gh-connect';
const APP_CONFIG = { appId: '1', slug: 'lake-app', privateKey: 'k', clientId: 'client-1', clientSecret: 's' };

let mongoServer: MongoMemoryServer;

const makeRes = () => {
  const headers: Record<string, unknown> = {};
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = {
    json,
    status,
    headersSent: false,
    getHeader: (name: string) => headers[name.toLowerCase()],
    setHeader: (name: string, value: unknown) => void (headers[name.toLowerCase()] = value),
  };
  const setCookies = () => [headers['set-cookie'] ?? []].flat().map(String);
  return { res: res as never, json, status, setCookies };
};
const makeReq = (body: Record<string, unknown>, userId = 'user-gh-connect', extra: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    body,
    user: { id: userId, isAdmin: false },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    ...extra,
  }) as never;
const lakeIdOf = (json: ReturnType<typeof makeRes>['json']) =>
  (json.mock.calls[0][0] as { dataLakeId: string }).dataLakeId;
type Handler = (req: unknown, res: unknown) => Promise<void>;
const run = (req: unknown, res: unknown, h_: unknown = handler) => (h_ as Handler)(req, res);

const counts = async () => ({
  lakes: await DataLakeModel.countDocuments({}),
  grants: await DataLakeAccessGrantModel.countDocuments({}),
  audits: await LakeConfigChangeEventModel.countDocuments({}),
});

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await DataLakeModel.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(() => {
  h.flags.EnableDataLakes = true;
  h.flags.EnableDataLakeGitHub = true;
  h.verifyOrgAccess.mockReset().mockResolvedValue({ id: ORG });
  h.getGitHubLakeAppConfig.mockReset().mockReturnValue(APP_CONFIG);
  h.createStateToken
    .mockReset()
    .mockImplementation((_opts: unknown, params: { dataLakeId: string }) => `state-for-${params.dataLakeId}`);
});

afterEach(async () => {
  await Promise.all([
    DataLakeModel.deleteMany({}),
    DataLakeAccessGrantModel.deleteMany({}),
    LakeConfigChangeEventModel.deleteMany({}),
  ]);
});

describe('POST /api/data-lakes/github-connect', () => {
  it('creates a draft connector-fed org lake awaiting GitHub and returns its authorize URL', async () => {
    const { res, json, setCookies } = makeRes();
    await run(makeReq({ organizationId: ORG }), res);

    const { dataLakeId, authorizeUrl } = json.mock.calls[0][0] as { dataLakeId: string; authorizeUrl: string };
    const lake = await DataLakeModel.findById(dataLakeId).lean();
    expect(lake).toMatchObject({
      name: GITHUB_LAKE_PLACEHOLDER_NAME,
      origin: 'connector-fed',
      pendingConnector: 'github',
      status: 'draft',
      organizationId: ORG,
      createdByUserId: 'user-gh-connect',
    });
    expect(lake?.slug).toMatch(/^github-repo-[0-9a-f]{8}$/);
    expect(await DataLakeAccessGrantModel.countDocuments({ dataLakeId, role: 'owner' })).toBe(1);
    expect(await LakeConfigChangeEventModel.countDocuments({ action: 'create' })).toBe(1);

    expect(h.verifyOrgAccess).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-gh-connect' }), ORG);
    expect(new URL(authorizeUrl).searchParams.get('state')).toBe(`state-for-${dataLakeId}`);
    expect(setCookies().some(c => c.includes('github-lake-connect=') && !c.includes('Max-Age=0'))).toBe(true);
  });

  it.each([
    ['a personal (missing) organizationId', {}],
    ['an empty organizationId', { organizationId: '  ' }],
  ])('refuses %s with a 400 before creating anything', async (_label, body) => {
    const { res } = makeRes();
    await expect(run(makeReq(body), res)).rejects.toMatchObject({ statusCode: 400 });
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
  });

  it('refuses an API-key caller with a 403 before creating anything', async () => {
    const { res } = makeRes();
    // Write-scoped, so the scope gate admits it and only the session-only refusal can stop it.
    const req = makeReq({ organizationId: ORG }, 'user-gh-connect', {
      apiKeyInfo: { keyId: 'key-1', scopes: ['datalake:write'] },
    });
    await expect(run(req, res)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/signed-in session/),
    });
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
    expect(h.verifyOrgAccess).not.toHaveBeenCalled();
  });

  it("reuses the caller's unbound placeholder lake on a retried connect instead of inserting another", async () => {
    const first = makeRes();
    await run(makeReq({ organizationId: ORG }), first.res);
    const second = makeRes();
    await run(makeReq({ organizationId: ORG }), second.res);

    expect(lakeIdOf(second.json)).toBe(lakeIdOf(first.json));
    expect(await counts()).toEqual({ lakes: 1, grants: 1, audits: 1 });
    const { authorizeUrl } = second.json.mock.calls[0][0] as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get('state')).toBe(`state-for-${lakeIdOf(first.json)}`);
  });

  it.each([
    ['started by another user', { createdByUserId: 'someone-else' }],
    ['already bound (pending connector cleared)', { $unset: { pendingConnector: 1 } }],
    ['renamed by the user', { name: 'My lake' }],
    ['no longer a draft', { status: 'active' }],
  ])('does not reuse a placeholder lake %s', async (_label, update) => {
    const first = makeRes();
    await run(makeReq({ organizationId: ORG }), first.res);
    await DataLakeModel.updateOne({ _id: lakeIdOf(first.json) }, update);

    const second = makeRes();
    await run(makeReq({ organizationId: ORG }), second.res);
    expect(lakeIdOf(second.json)).not.toBe(lakeIdOf(first.json));
    expect(await DataLakeModel.countDocuments({})).toBe(2);
  });

  it('keeps a reused lake when the authorize URL cannot be minted', async () => {
    const first = makeRes();
    await run(makeReq({ organizationId: ORG }), first.res);
    h.createStateToken.mockImplementation(() => {
      throw new Error('JWT secret missing');
    });
    await expect(run(makeReq({ organizationId: ORG }), makeRes().res)).rejects.toThrow('JWT secret missing');
    expect(await counts()).toEqual({ lakes: 1, grants: 1, audits: 1 });
  });

  it('refuses a caller who cannot manage the org before creating anything', async () => {
    h.verifyOrgAccess.mockRejectedValue(new NotFoundError('Organization not found'));
    const { res } = makeRes();
    await expect(run(makeReq({ organizationId: ORG }), res)).rejects.toBeInstanceOf(NotFoundError);
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
  });

  it.each(['EnableDataLakes', 'EnableDataLakeGitHub'])('creates nothing while %s is off', async flag => {
    h.flags[flag] = false;
    const { res, status } = makeRes();
    await run(makeReq({ organizationId: ORG }), res);
    expect(status).toHaveBeenCalledWith(404);
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
  });

  it('creates nothing when the GitHub App is not configured', async () => {
    h.getGitHubLakeAppConfig.mockReturnValue(null);
    const { res } = makeRes();
    await expect(run(makeReq({ organizationId: ORG }), res)).rejects.toThrow(/not configured/);
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
  });

  it('deletes the lake and its grant and expires the nonce cookie when the authorize URL cannot be minted', async () => {
    h.createStateToken.mockImplementation(() => {
      throw new Error('JWT secret missing');
    });
    const { res, setCookies } = makeRes();
    await expect(run(makeReq({ organizationId: ORG }), res)).rejects.toThrow('JWT secret missing');

    expect(await DataLakeModel.countDocuments({})).toBe(0);
    expect(await DataLakeAccessGrantModel.countDocuments({})).toBe(0);
    const audits = await LakeConfigChangeEventModel.find({}).sort({ createdAt: 1, _id: 1 }).lean();
    expect(audits.map(a => a.action)).toEqual(['create', 'delete']);
    expect(new Set(audits.map(a => a.dataLakeId)).size).toBe(1);
    expect(audits[1]).toMatchObject({ principalId: 'user-gh-connect' });
    expect(audits[1].changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'status', before: 'draft', after: 'deleted' })])
    );
    expect(setCookies().some(c => c.includes('github-lake-connect=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('gives two users connecting concurrently in one org distinct lakes', async () => {
    const a = makeRes();
    const b = makeRes();
    await Promise.all([
      run(makeReq({ organizationId: ORG }, 'user-a'), a.res),
      run(makeReq({ organizationId: ORG }, 'user-b'), b.res),
    ]);
    const ids = [a.json, b.json].map(j => (j.mock.calls[0][0] as { dataLakeId: string }).dataLakeId);
    const lakes = await DataLakeModel.find({ _id: { $in: ids } }).lean();
    expect(lakes).toHaveLength(2);
    expect(new Set(lakes.map(l => l.slug)).size).toBe(2);
    expect(new Set(lakes.map(l => l.datalakeTag)).size).toBe(2);
  });

  it('converges two concurrent connects by one caller on a single lake', async () => {
    const a = makeRes();
    const b = makeRes();
    await Promise.all([run(makeReq({ organizationId: ORG }), a.res), run(makeReq({ organizationId: ORG }), b.res)]);
    expect(lakeIdOf(a.json)).toBe(lakeIdOf(b.json));
    expect(await DataLakeModel.countDocuments({})).toBe(1);
    expect(await DataLakeAccessGrantModel.countDocuments({ dataLakeId: { $ne: lakeIdOf(a.json) } })).toBe(0);
  });

  it('still deletes the lake and records the delete when the grant cleanup rejects', async () => {
    const spy = vi
      .spyOn(dataLakeAccessGrantRepository, 'removeAllForLake')
      .mockRejectedValueOnce(new Error('grant delete failed'));
    h.createStateToken.mockImplementation(() => {
      throw new Error('JWT secret missing');
    });
    const req = makeReq({ organizationId: ORG }) as unknown as { logger: { error: ReturnType<typeof vi.fn> } };
    try {
      await expect(run(req, makeRes().res)).rejects.toThrow('JWT secret missing');
    } finally {
      spy.mockRestore();
    }
    expect(await DataLakeModel.countDocuments({})).toBe(0);
    expect(req.logger.error).toHaveBeenCalledWith(
      'GitHub lake connect: could not roll back the pending lake',
      expect.objectContaining({ error: expect.objectContaining({ message: 'grant delete failed' }) })
    );
    const audits = await LakeConfigChangeEventModel.find({}).sort({ createdAt: 1, _id: 1 }).lean();
    expect(audits.map(a => a.action)).toEqual(['create', 'delete']);
  });

  it('creates a lake the bind-time rename renames, stamps and audits', async () => {
    const { res, json } = makeRes();
    await run(makeReq({ organizationId: ORG }), res);
    const dataLakeId = lakeIdOf(json);
    const created = await DataLakeModel.findById(dataLakeId).lean();
    const logger = { warn: vi.fn() };

    await nameLakeAfterRepository(dataLakeId, 'acme/repo', { id: 'binder-1', isAdmin: false }, logger);

    const bound = await DataLakeModel.findById(dataLakeId).lean();
    expect(bound?.name).toBe('acme/repo');
    expect(bound?.lastUpdatedByUserId).toBe('binder-1');
    expect(bound).not.toHaveProperty('pendingConnector');
    expect(bound?.slug).toBe(created?.slug);
    expect(bound?.datalakeTag).toBe(created?.datalakeTag);
    const update = await LakeConfigChangeEventModel.findOne({ dataLakeId, action: 'update' }).lean();
    expect(update).toMatchObject({ principalId: 'binder-1', organizationId: ORG });
    expect(update?.changes).toEqual([
      expect.objectContaining({ field: 'name', before: GITHUB_LAKE_PLACEHOLDER_NAME, after: 'acme/repo' }),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries once with a fresh suffix when the first one collides', async () => {
    const suffixes = ['0000aaaa', '0000aaaa', '1111bbbb'];
    const collidingHandler = createGitHubConnectHandler(() => suffixes.shift()!);
    await run(makeReq({ organizationId: ORG }, 'user-a'), makeRes().res, collidingHandler);

    const second = makeRes();
    await run(makeReq({ organizationId: ORG }, 'user-b'), second.res, collidingHandler);
    const { dataLakeId } = second.json.mock.calls[0][0] as { dataLakeId: string };
    expect((await DataLakeModel.findById(dataLakeId).lean())?.slug).toBe('github-repo-1111bbbb');
    expect(suffixes).toHaveLength(0);
  });
});
