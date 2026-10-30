// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertCanWriteDataLakeTags: vi.fn(),
  toggleTags: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return {
    dataLakeService: {
      assertCanWriteDataLakeTags: h.assertCanWriteDataLakeTags,
      extractDataLakeMetaTags: actual.dataLakeService.extractDataLakeMetaTags,
    },
    fabFilesService: { toggleTags: h.toggleTags },
  };
});
vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: { markSourceShredded: vi.fn().mockResolvedValue(0) },
  withTransaction: async (fn: () => unknown) => fn(),
  lakeConfigChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  lakeMembershipChangeEventRepository: { record: vi.fn().mockResolvedValue({}) },
  dataLakeRepository: { name: 'dataLakes', findByDatalakeTags: vi.fn().mockResolvedValue([]) },
  dataLakeAccessGrantRepository: {
    listByLake: vi.fn().mockResolvedValue([]),
    listActiveByLakes: vi.fn().mockResolvedValue([]),
    listByPrincipal: vi.fn().mockResolvedValue([]),
    findGrant: vi.fn().mockResolvedValue(null),
    upsertGrant: vi.fn().mockResolvedValue({}),
    removeGrant: vi.fn().mockResolvedValue(true),
    removeAllForLake: vi.fn().mockResolvedValue(0),
  },
  fabFileRepository: { name: 'fabFiles', setOwnerOrganizationIfUnchanged: vi.fn().mockResolvedValue(true) },
  fileTagRepository: { name: 'fileTags' },
  userRepository: {
    name: 'users',
    findById: vi.fn().mockResolvedValue(null),
    incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
  },
  organizationRepository: {
    findById: vi.fn().mockResolvedValue(null),
    incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
  },
  adminSettingsRepository: { name: 'adminSettings' },
  scopedSettingsRepository: { name: 'scopedSettings' },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (req: { user: { id: string; isAdmin?: boolean } }) => ({
    userId: req.user.id,
    isAdmin: !!req.user.isAdmin,
    userTags: [],
    organizationIds: [],
    entitlementKeys: [],
    administeredOrgIds: [],
  })),
}));

import handler from '../toggle';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};

const run = (res: unknown) =>
  (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(
    { method: 'POST', body: { ids: ['f1', 'f2'], tags: ['plain'] }, user: { id: 'u1', isAdmin: false } } as never,
    res
  );

describe('POST /api/files/tags/toggle response boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.assertCanWriteDataLakeTags.mockResolvedValue(undefined);
  });

  it('strips undeclared keys from every file and keeps prefixArmJoinedLakeCount', async () => {
    h.toggleTags.mockResolvedValue([
      {
        id: 'f1',
        fileName: 'a.txt',
        prefixArmJoinedLakeCount: 2,
        _id: 'raw-1',
        __v: 1,
        secretNotInSchema: 'leak',
      },
      { id: 'f2', fileName: 'b.txt', _id: 'raw-2', secretNotInSchema: 'leak' },
    ]);
    const { res, json } = makeRes();

    await run(res);

    const sent = json.mock.calls[0][0] as Record<string, unknown>[];
    expect(sent).toHaveLength(2);
    for (const file of sent) {
      expect(file).not.toHaveProperty('_id');
      expect(file).not.toHaveProperty('__v');
      expect(file).not.toHaveProperty('secretNotInSchema');
    }
    expect(sent[0]).toMatchObject({ id: 'f1', fileName: 'a.txt', prefixArmJoinedLakeCount: 2 });
    expect(sent[1]).toMatchObject({ id: 'f2', fileName: 'b.txt' });
    expect(sent[1]).not.toHaveProperty('prefixArmJoinedLakeCount');
  });
});
