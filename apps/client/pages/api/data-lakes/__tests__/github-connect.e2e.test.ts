import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { DataLakeModel, DataLakeAccessGrantModel, LakeConfigChangeEventModel } from '@bike4mind/database';
import { GITHUB_LAKE_PLACEHOLDER_NAME, NotFoundError } from '@bike4mind/common';

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
const makeReq = (body: Record<string, unknown>, userId = 'user-gh-connect') =>
  ({
    method: 'POST',
    body,
    user: { id: userId, isAdmin: false },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }) as never;
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
    await expect(run(makeReq(body), res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(await counts()).toEqual({ lakes: 0, grants: 0, audits: 0 });
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
    expect(setCookies().some(c => c.includes('github-lake-connect=;') && c.includes('Max-Age=0'))).toBe(true);
  });

  it('gives two concurrent connects in one org distinct lakes', async () => {
    const a = makeRes();
    const b = makeRes();
    await Promise.all([run(makeReq({ organizationId: ORG }), a.res), run(makeReq({ organizationId: ORG }), b.res)]);
    const ids = [a.json, b.json].map(j => (j.mock.calls[0][0] as { dataLakeId: string }).dataLakeId);
    const lakes = await DataLakeModel.find({ _id: { $in: ids } }).lean();
    expect(lakes).toHaveLength(2);
    expect(new Set(lakes.map(l => l.slug)).size).toBe(2);
    expect(new Set(lakes.map(l => l.datalakeTag)).size).toBe(2);
  });

  it('retries once with a fresh suffix when the first one collides', async () => {
    const suffixes = ['0000aaaa', '0000aaaa', '1111bbbb'];
    const collidingHandler = createGitHubConnectHandler(() => suffixes.shift()!);
    await run(makeReq({ organizationId: ORG }), makeRes().res, collidingHandler);

    const second = makeRes();
    await run(makeReq({ organizationId: ORG }), second.res, collidingHandler);
    const { dataLakeId } = second.json.mock.calls[0][0] as { dataLakeId: string };
    expect((await DataLakeModel.findById(dataLakeId).lean())?.slug).toBe('github-repo-1111bbbb');
    expect(suffixes).toHaveLength(0);
  });
});
