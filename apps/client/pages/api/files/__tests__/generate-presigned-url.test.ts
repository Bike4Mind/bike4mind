import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettingsMap, invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';
import { settingsMap } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  createFabFile: vi.fn(),
  findByDatalakeTag: vi.fn(),
  // The prefix-arm scope gate's candidate-lake lookup (assertDataLakeTagWriteScope's `newFile`
  // argument); empty by default so existing tests see no lake to match against.
  lakeFind: vi.fn(),
  batchFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  findOverrides: vi.fn(),
  s3ClientConfigs: [] as unknown[],
}));

// The route calls `baseApi().post(...)` directly, with no `.use(...)` in the chain.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (h: unknown) => h }),
}));

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-bucket' } } }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    constructor(config: unknown) {
      h.s3ClientConfigs.push(config);
    }
  },
  PutObjectCommand: class {
    constructor(public input: unknown) {}
  },
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn(async () => 'https://s3.test/put') }));

// The assertion point: whatever tags reach here are what gets persisted on the FabFile.
vi.mock('@server/managers/fabFileManager', () => ({ createFabFile: h.createFabFile }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  // Scoped-override store the admission contract's lever (#1680) resolves through.
  scopedSettingsRepository: { findOverrides: h.findOverrides },
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, find: h.lakeFind },
  dataLakeBatchRepository: { findById: h.batchFindById },
  dataLakeAccessGrantRepository: { listByLake: vi.fn().mockResolvedValue([]) },
}));

// The endpoint resolves its actor via toAccessContext (#1668); stub it so the real one's
// entitlements + org-admin DB reads don't get pulled into this unit test. The actor identity still
// comes from req.user (never the body), preserving the security property the route depends on.
vi.mock('@server/dataLakes/toAccessContext', () => ({
  toAccessContext: vi.fn(async (req: { user: { id: string; isAdmin?: boolean } }) => ({
    userId: req.user.id,
    isAdmin: !!req.user.isAdmin,
    userTags: [],
    entitlementKeys: [],
    administeredOrgIds: [],
  })),
}));

// Only the settings read is stubbed; checkStorageLimit and resolveSupportedMimeType are real
// gates on this path. The reconciler (via @bike4mind/services) is left real entirely.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

import handler from '../generate-presigned-url';

const LAKE = {
  id: 'lake-1',
  // Slug and prefix deliberately differ: deriving the fallback from the slug instead of the
  // lake's fileTagPrefix would otherwise pass unnoticed.
  slug: 'acme-2026',
  createdByUserId: 'u1',
  datalakeTag: 'datalake:orga:acme-2026',
  fileTagPrefix: 'acme:',
};

const makeRes = () => {
  const json = vi.fn();
  const res = { json, status: vi.fn(() => ({ json })) } as never;
  return { res, json };
};

const req = (body: unknown, overrides: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    user: { id: 'u1', isAdmin: false },
    ability: {},
    body,
    logger: { error: vi.fn(), warn: vi.fn() },
    ...overrides,
  }) as never;

const run = (body: unknown, res: unknown, overrides?: Record<string, unknown>) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(body, overrides), res);

const body = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  ...overrides,
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.createFabFile.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return persisted.tags?.map(t => t.name).sort();
};

describe('POST /api/files/generate-presigned-url - S3 client config', () => {
  it('sets requestChecksumCalculation to WHEN_REQUIRED (#1535)', () => {
    // Without this, getSignedUrl signs in a checksum of the empty sign-time body, which then
    // mismatches whatever the browser actually PUTs.
    expect(h.s3ClientConfigs[0]).toMatchObject({ requestChecksumCalculation: 'WHEN_REQUIRED' });
  });
});

describe('POST /api/files/generate-presigned-url - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.lakeFind.mockResolvedValue([]);
    h.createFabFile.mockImplementation(async () => ({ id: 'f1' }));
  });

  it('stamps the lake prefix when a lake meta-tag arrives with no tag under that prefix', async () => {
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(tagNamesOf()).toEqual(['acme:uncategorized', 'datalake:orga:acme-2026']);
  });

  it('adds no extra stamp when a tag under the lake prefix is already present', async () => {
    const { res } = makeRes();
    await run(
      body({
        tags: [
          { name: 'datalake:orga:acme-2026', strength: 1 },
          { name: 'acme:legal', strength: 1 },
        ],
      }),
      res
    );

    expect(tagNamesOf()).toEqual(['acme:legal', 'datalake:orga:acme-2026']);
  });

  it('leaves a request with no lake meta-tag untouched and never looks a lake up', async () => {
    const { res } = makeRes();
    await run(body(), res);

    expect(h.createFabFile.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
  });

  // This route creates the FabFile through the manager's direct FabFile.create(), not the
  // fabFileService.createFabFile door that gates this namespace centrally - it needs its own
  // check, same as the meta-tag one above.
  it('refuses a non-admin self-applying a static-registry-prefixed tag (e.g. opti:)', async () => {
    const { res } = makeRes();
    await expect(run(body({ tags: [{ name: 'opti:report', strength: 1 }] }), res)).rejects.toThrow(
      /only an admin can change this data lake/i
    );
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  // Regression test: a plain content tag matching the caller's OWN lake's fileTagPrefix joins
  // that lake via the prefix arm (no `datalake:*` meta-tag involved), so a scope check keyed only
  // on meta-tags previously let a files:write-only key join a lake this way with no data-lake
  // scope at all.
  it('refuses a files:write-only key applying a tag under its own lake prefix (no meta-tag)', async () => {
    h.lakeFind.mockResolvedValue([LAKE]);
    const { res } = makeRes();
    await expect(
      run(body({ tags: [{ name: 'acme:legal', strength: 1 }] }), res, { apiKeyInfo: { scopes: ['files:write'] } })
    ).rejects.toThrow(/datalake:write is required/);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('allows a key holding datalake:write to join a lake via its prefix arm alone', async () => {
    h.lakeFind.mockResolvedValue([LAKE]);
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'acme:legal', strength: 1 }] }), res, {
      apiKeyInfo: { scopes: ['datalake:write'] },
    });

    expect(h.createFabFile).toHaveBeenCalled();
  });

  it('does not gate a tag matching no lake the caller owns', async () => {
    h.lakeFind.mockResolvedValue([{ ...LAKE, createdByUserId: 'someone-else' }]);
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'acme:legal', strength: 1 }] }), res, {
      apiKeyInfo: { scopes: ['files:write'] },
    });

    expect(h.createFabFile).toHaveBeenCalled();
  });
});

/**
 * The admission contract (#1680) at this door. It reaches it through
 * `assertCanWriteDataLakeTags`' `members` option - the contract's ONLY opt-in signal - and the real
 * service runs here, so deleting that option makes this refusal disappear.
 */
describe('POST /api/files/generate-presigned-url - admission contract', () => {
  // Deliberately not a round number: the owner's chunk policy resolves to a coded default here, and
  // a required target that happened to match it would satisfy the contract instead of violating it.
  const ENFORCING_LAKE = { ...LAKE, requiredPassageTokenTarget: 4321 };

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSettingsCache();
    invalidateScopedSettingsCache();
    h.findByDatalakeTag.mockResolvedValue(ENFORCING_LAKE);
    h.createFabFile.mockImplementation(async () => ({ id: 'f1' }));
    h.findOverrides.mockResolvedValue([
      { scopeLevel: 'lake', scopeId: 'lake-1', settingName: 'EnforceLakeAdmission', settingValue: 'true' },
    ]);
  });

  it('refuses the upload before any presigned URL when the lake enforces and the policy disagrees', async () => {
    const { res } = makeRes();

    await expect(run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res)).rejects.toThrow(
      /requires passages of 4321/
    );
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('allows it when no scoped override turns the lever on - report-only is the default', async () => {
    h.findOverrides.mockResolvedValue([]);
    const { res } = makeRes();

    await run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/files/generate-presigned-url - batch ownership (IDOR guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockImplementation(async () => ({ id: 'f1' }));
    h.getSettingsValue.mockResolvedValue(true);
  });

  it('never looks up a batch or checks the feature flag when none was sent', async () => {
    const { res } = makeRes();
    await run(body(), res);

    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });

  it('refuses a batchId when Data Lakes is disabled, before ever looking the batch up', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/feature/i);
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('stamps batchId onto the created file when the caller owns the batch', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const { res } = makeRes();
    await run(body({ batchId: 'b1' }), res);

    expect(h.batchFindById).toHaveBeenCalledWith('b1');
    expect(h.createFabFile.mock.calls[0][0]).toMatchObject({ batchId: 'b1' });
  });

  it('rejects a batchId belonging to another user, without creating a file', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'someone-else' });
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  it('rejects a batchId that does not exist, without creating a file', async () => {
    h.batchFindById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/files/generate-presigned-url - MaxFileSize resolution', () => {
  const DEFAULT_MB = settingsMap.MaxFileSize.defaultValue!;
  const mb = (n: number) => n * 1024 * 1024;

  beforeEach(() => {
    vi.clearAllMocks();
    h.createFabFile.mockImplementation(async () => ({ id: 'f1' }));
  });

  // A non-numeric or cleared value must land on the schema default, not disable the cap: the
  // route used to parseInt the raw setting, and NaN made every `fileSize >= maxFileSize`
  // comparison false, so an arbitrarily large file sailed through.
  it.each([
    ['non-numeric', 'abc'],
    ['cleared', ''],
  ])('still caps at the schema default when the stored setting is %s', async (_label, stored) => {
    vi.mocked(getSettingsMap).mockResolvedValue({ MaxFileSize: stored });
    const { res } = makeRes();

    await expect(run(body({ fileSize: mb(DEFAULT_MB + 5) }), res)).rejects.toThrow(/maximum file size/i);
    expect(h.createFabFile).not.toHaveBeenCalled();
  });

  // Deliberately a cleared value and a size between the old hardcoded 20MB fallback and the
  // schema default: anything lower passes under both, so it would guard nothing.
  it('accepts a file the old hardcoded fallback would have refused', async () => {
    vi.mocked(getSettingsMap).mockResolvedValue({ MaxFileSize: '' });
    const { res } = makeRes();

    await run(body({ fileSize: mb(DEFAULT_MB - 5) }), res);
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });

  it('honors a valid stored setting over the schema default', async () => {
    vi.mocked(getSettingsMap).mockResolvedValue({ MaxFileSize: String(DEFAULT_MB + 20) });
    const { res } = makeRes();

    await run(body({ fileSize: mb(DEFAULT_MB + 5) }), res);
    expect(h.createFabFile).toHaveBeenCalledTimes(1);
  });
});
