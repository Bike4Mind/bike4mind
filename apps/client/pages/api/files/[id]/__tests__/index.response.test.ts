// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  updateFileForUser: vi.fn(),
  assertCanWriteDataLakeTags: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'PUT']?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.GET = fns[fns.length - 1]), chain),
      put: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.PUT = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/files/updateFileForUser', () => ({ updateFileForUser: h.updateFileForUser }));
vi.mock('@server/dataLakes/dataLakeScopes', () => ({ assertDataLakeTagWriteScope: vi.fn() }));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: async (req: { user: { id: string } }) => ({
    userId: req.user.id,
    isAdmin: false,
    userTags: [],
    organizationIds: [],
    entitlementKeys: [],
    administeredOrgIds: [],
  }),
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    ...actual,
    dataLakeService: { ...actual.dataLakeService, assertCanWriteDataLakeTags: h.assertCanWriteDataLakeTags },
  };
});
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn() }),
}));

import handler from '../index';

const FILE_ID = '507f1f77bcf86cd799439011';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (res: unknown, apiKeyInfo?: { keyId: string; scopes?: string[] }) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    {
      method: 'PUT',
      user: { id: 'u1', isAdmin: false },
      ability: {},
      query: { id: FILE_ID },
      body: { fileName: 'notes.txt' },
      apiKeyInfo,
      logger: { updateMetadata: vi.fn(), error: vi.fn(), warn: vi.fn() },
    } as never,
    res
  );

describe('PUT /api/files/[id] response boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertCanWriteDataLakeTags.mockResolvedValue(undefined);
    h.updateFileForUser.mockResolvedValue({
      id: FILE_ID,
      userId: 'u1',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      _id: 'raw-object-id',
      __v: 5,
      secretNotInSchema: 'leak',
    });
  });

  it('strips undeclared keys and keeps declared ones for a session caller', async () => {
    const { res, json } = makeRes();

    await run(res);

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent).toMatchObject({ id: FILE_ID, userId: 'u1', fileName: 'notes.txt', mimeType: 'text/plain' });
  });

  it('strips undeclared keys and omits the file URL for a caller without a files read scope', async () => {
    const { res, json } = makeRes();

    await run(res, { keyId: 'k1', scopes: ['files:write'] });

    const sent = json.mock.calls[0][0] as Record<string, unknown>;
    expect(sent).not.toHaveProperty('_id');
    expect(sent).not.toHaveProperty('__v');
    expect(sent).not.toHaveProperty('secretNotInSchema');
    expect(sent.fileUrl).toBeUndefined();
    expect(sent).toMatchObject({ id: FILE_ID, fileName: 'notes.txt' });
  });
});
