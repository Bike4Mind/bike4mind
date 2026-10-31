import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiKeyScope, KnowledgeType, createModalVideoSchema } from '@bike4mind/common';
import { deploymentMediaOrigins } from '@server/utils/deploymentMediaOrigins';
import { invalidateScopedSettingsCache, invalidateSettingsCache } from '@bike4mind/utils';

const h = vi.hoisted(() => ({
  fabFileCreate: vi.fn(),
  signUrl: vi.fn(),
  userFindById: vi.fn(),
  findByDatalakeTag: vi.fn(),
  // The prefix-arm scope gate's candidate-lake lookup (assertDataLakeTagWriteScope's `newFile`
  // argument); empty by default so existing tests see no lake to match against.
  lakeFind: vi.fn(),
  batchFindById: vi.fn(),
  getSettingsValue: vi.fn(),
  findOverrides: vi.fn(),
  listByLake: vi.fn(),
  // The acting principal's org-admin set, as a test input rather than a Mongo read. The gates that
  // consume it are the real ones.
  administeredOrgIds: [] as string[],
  baseApiOptions: undefined as unknown,
}));

// Single-method chain: the route only calls `.use(...).post(...)`, and the ability check in
// `.use` is not the subject here, so the middleware itself is dropped rather than run. Captures
// the options for the scope-gate test below.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    return { use: () => ({ post: (h: unknown) => h }) };
  },
}));

vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/utils/browserUploadUrl', () => ({ resolveBrowserUploadUrl: (_id: string, url: string) => url }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: h.signUrl }),
}));

vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: async (id: string) => ({ id, currentStorageSize: 0 }) },
  adminSettingsRepository: { getSettingsValue: h.getSettingsValue },
  // Scoped-override store the admission contract's lever (#1680) resolves through.
  scopedSettingsRepository: { findOverrides: h.findOverrides },
  dataLakeRepository: { findByDatalakeTag: h.findByDatalakeTag, find: h.lakeFind },
  dataLakeBatchRepository: { findById: h.batchFindById },
  dataLakeAccessGrantRepository: { listByLake: h.listByLake },
  fabFileRepository: { update: vi.fn() },
  userRepository: {},
  FabFile: { create: h.fabFileCreate },
  User: { findById: h.userFindById },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
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
    administeredOrgIds: h.administeredOrgIds,
  })),
}));

// Only the settings read is stubbed; checkStorageLimitForOwner, resolveSupportedMimeType, etc.
// are real gates on this path.
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSettingsMap: vi.fn(async () => ({})) };
});

vi.mock('sst', () => ({ Resource: { fabFileBucket: { name: 'test-fab-bucket' } } }));

import handler from '../createFabFile';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { withholdAdminRole } from '@bike4mind/server-utils/auth/apiKeyAdminScope';

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

const req = (body: unknown, userId = 'u1', overrides: Record<string, unknown> = {}) =>
  ({
    method: 'POST',
    user: { id: userId, isAdmin: false },
    ability: {},
    body,
    logger: { error: vi.fn(), warn: vi.fn() },
    ...overrides,
  }) as never;

const run = (body: unknown, res: unknown, overrides?: Record<string, unknown>) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(body, 'u1', overrides), res);

const runAs = (userId: string, body: unknown, res: unknown) =>
  (handler as (req: unknown, res: unknown) => Promise<void>)(req(body, userId), res);

const body = (overrides: Record<string, unknown> = {}) => ({
  fileName: 'report.txt',
  mimeType: 'text/plain',
  fileSize: 10,
  type: KnowledgeType.FILE,
  ...overrides,
});

// File-scoped so every describe below starts from "no grants, administers nothing" - the two
// inputs that decide whether the lake gates fall back to the creator rung alone.
beforeEach(() => {
  h.listByLake.mockResolvedValue([]);
  h.administeredOrgIds = [];
});

const tagNamesOf = (callIndex = 0) => {
  const persisted = h.fabFileCreate.mock.calls[callIndex][0] as { tags?: { name: string }[] };
  return persisted.tags?.map(t => t.name).sort();
};

describe('POST /api/files/createFabFile - data-lake tags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(LAKE);
    h.lakeFind.mockResolvedValue([]);
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
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

    expect(h.fabFileCreate.mock.calls[0][0]).not.toHaveProperty('tags');
    expect(h.findByDatalakeTag).not.toHaveBeenCalled();
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
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('allows a key holding datalake:write to join a lake via its prefix arm alone', async () => {
    h.lakeFind.mockResolvedValue([LAKE]);
    const { res } = makeRes();
    // files:write too: the route gate (stubbed here) and the release-notes narrowing both need it.
    await run(body({ tags: [{ name: 'acme:legal', strength: 1 }] }), res, {
      apiKeyInfo: { scopes: ['files:write', 'datalake:write'] },
    });

    expect(h.fabFileCreate).toHaveBeenCalled();
  });

  it('does not gate a tag matching no lake the caller owns', async () => {
    h.lakeFind.mockResolvedValue([{ ...LAKE, createdByUserId: 'someone-else' }]);
    const { res } = makeRes();
    await run(body({ tags: [{ name: 'acme:legal', strength: 1 }] }), res, {
      apiKeyInfo: { scopes: ['files:write'] },
    });

    expect(h.fabFileCreate).toHaveBeenCalled();
  });
});

describe('POST /api/files/createFabFile - executable mime types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
  });

  // fabFileBucket is not app-origin-served (unlike the presign siblings on appFilesBucket), and
  // html/svg are normal knowledge-ingestion inputs (text/html is what the session file picker
  // posts for a .html file), so this route does NOT reject them for being "executable" - that gate
  // lives only on the app-origin presigns. (Types the service's own supported-mime list rejects,
  // e.g. application/xhtml+xml, are a separate concern and still refused there.)
  it.each(['image/svg+xml', 'text/html'])('accepts %s and creates the file', async mimeType => {
    const { res } = makeRes();
    await run(body({ fileName: 'x', mimeType }), res);
    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('allows a normal image type', async () => {
    const { res } = makeRes();
    await run(body({ fileName: 'logo.png', mimeType: 'image/png' }), res);
    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });
});

/**
 * The admission contract (#1680) at this door. It reaches it through
 * `assertCanWriteDataLakeTags`' `members` option - the contract's ONLY opt-in signal - and the real
 * service runs here, so deleting that option makes this refusal disappear.
 */
describe('POST /api/files/createFabFile - admission contract', () => {
  // Deliberately not a round number: the owner's chunk policy resolves to a coded default here, and
  // a required target that happened to match it would satisfy the contract instead of violating it.
  const ENFORCING_LAKE = { ...LAKE, requiredPassageTokenTarget: 4321 };

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateSettingsCache();
    invalidateScopedSettingsCache();
    h.findByDatalakeTag.mockResolvedValue(ENFORCING_LAKE);
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
    h.findOverrides.mockResolvedValue([
      { scopeLevel: 'lake', scopeId: 'lake-1', settingName: 'EnforceLakeAdmission', settingValue: 'true' },
    ]);
  });

  it('refuses the create when the lake enforces and the chunk policy disagrees', async () => {
    const { res } = makeRes();

    await expect(run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res)).rejects.toThrow(
      /requires passages of 4321/
    );
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('allows it when no scoped override turns the lever on - report-only is the default', async () => {
    h.findOverrides.mockResolvedValue([]);
    const { res } = makeRes();

    await run(body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/files/createFabFile - batch ownership (IDOR guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
    h.getSettingsValue.mockResolvedValue(true);
  });

  it('never looks up a batch or checks the feature flag when none was sent', async () => {
    const { res } = makeRes();
    await run(body(), res);

    expect(h.getSettingsValue).not.toHaveBeenCalled();
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a batchId when Data Lakes is disabled, before ever looking the batch up', async () => {
    h.getSettingsValue.mockResolvedValue(false);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/feature/i);
    expect(h.batchFindById).not.toHaveBeenCalled();
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('stamps batchId onto the created file when the caller owns the batch', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'u1' });
    const { res } = makeRes();
    await run(body({ batchId: 'b1' }), res);

    expect(h.batchFindById).toHaveBeenCalledWith('b1');
    expect(h.fabFileCreate.mock.calls[0][0]).toMatchObject({ batchId: 'b1' });
  });

  it('rejects a batchId belonging to another user, without creating a file', async () => {
    h.batchFindById.mockResolvedValue({ id: 'b1', userId: 'someone-else' });
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('rejects a batchId that does not exist, without creating a file', async () => {
    h.batchFindById.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(run(body({ batchId: 'b1' }), res)).rejects.toThrow(/batch not found/i);
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });
});

/**
 * The write authorization at this door, run for real: the route's prologue gate AND the re-gate
 * inside `fabFilesService.createFabFile` both have to admit the caller. The service builds its own
 * actor and loads its own grants from the adapters it is handed, so a `db` without
 * `dataLakeAccessGrants` or a missing `administeredOrgIds` refuses a caller the prologue accepted
 * one function call earlier.
 */
describe('POST /api/files/createFabFile - lake write authorization beyond the creator', () => {
  // Created by someone else and scoped to an org, so neither the creator nor the admin rung can be
  // what admits the caller.
  const ORG_LAKE = { ...LAKE, createdByUserId: 'someone-else', organizationId: 'org-1' };

  beforeEach(() => {
    vi.clearAllMocks();
    h.listByLake.mockResolvedValue([]);
    h.administeredOrgIds = [];
    h.findByDatalakeTag.mockResolvedValue(ORG_LAKE);
    h.userFindById.mockResolvedValue({ id: 'u2', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
  });

  it('admits an org admin of the lake org who holds no grant and did not create it', async () => {
    h.administeredOrgIds = ['org-1'];
    const { res } = makeRes();

    await runAs('u2', body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('admits a curator grant holder', async () => {
    h.listByLake.mockResolvedValue([{ principalType: 'user', principalId: 'u2', role: 'curator' }]);
    const { res } = makeRes();

    await runAs('u2', body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('admits a transferred owner - an owner grant supersedes the creator', async () => {
    h.listByLake.mockResolvedValue([{ principalType: 'user', principalId: 'u2', role: 'owner' }]);
    const { res } = makeRes();

    await runAs('u2', body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res);

    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });

  it('still refuses a caller with no manage rung at all', async () => {
    const { res } = makeRes();

    await expect(runAs('u2', body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] }), res)).rejects.toThrow(
      /permission to change this data lake's files/
    );
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/files/createFabFile - admin-owned API keys', () => {
  const OTHER_LAKE = { ...LAKE, createdByUserId: 'someone-else', organizationId: 'org-1' };
  const lakeTag = body({ tags: [{ name: 'datalake:orga:acme-2026', strength: 1 }] });
  const keyCaller = (scopes: ApiKeyScope[]) => {
    const user = { id: 'u2', isAdmin: true };
    return {
      user: scopes.includes(ApiKeyScope.ADMIN) ? user : withholdAdminRole(user),
      apiKeyInfo: { keyId: 'k1', scopes },
    };
  };
  const callAs = (overrides: Record<string, unknown>, res: unknown) =>
    (handler as (req: unknown, res: unknown) => Promise<void>)(req(lakeTag, 'u2', overrides), res);

  beforeEach(() => {
    vi.clearAllMocks();
    h.findByDatalakeTag.mockResolvedValue(OTHER_LAKE);
    h.lakeFind.mockResolvedValue([]);
    h.userFindById.mockResolvedValue({ id: 'u2', isAdmin: true, storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
  });

  it('refuses a key without the admin scope', async () => {
    const { res } = makeRes();

    await expect(callAs(keyCaller([ApiKeyScope.WRITE_FILES, ApiKeyScope.DATALAKE_WRITE]), res)).rejects.toThrow(
      /permission to change this data lake's files/
    );
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('refuses it in the service re-check as well', async () => {
    vi.mocked(toAccessContext).mockResolvedValueOnce({
      userId: 'u2',
      isAdmin: true,
      userTags: [],
      entitlementKeys: [],
      administeredOrgIds: [],
    } as never);
    const { res } = makeRes();

    await expect(callAs(keyCaller([ApiKeyScope.WRITE_FILES, ApiKeyScope.DATALAKE_WRITE]), res)).rejects.toThrow(
      /permission to change this data lake's files/
    );
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('admits a key holding the admin scope', async () => {
    const { res } = makeRes();

    await callAs(keyCaller([ApiKeyScope.ADMIN, ApiKeyScope.WRITE_FILES, ApiKeyScope.DATALAKE_WRITE]), res);

    expect(h.fabFileCreate).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/files/createFabFile - scope gate', () => {
  it('requires files:write, or release-notes:write for the narrowed form below, at the baseApi route gate', () => {
    expect(h.baseApiOptions).toEqual({ requiredScopes: ['files:write', 'release-notes:write'] });
  });
});

describe('POST /api/files/createFabFile - signing boundaries', () => {
  // A browser URL distinct from the cached private one is only minted on split-endpoint deploys.
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('S3_PRESIGN_ENDPOINT', 'https://public.test');
    h.findByDatalakeTag.mockResolvedValue(null);
    h.lakeFind.mockResolvedValue([]);
    h.userFindById.mockResolvedValue({ id: 'u1', storageLimit: 1000, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data, moderationStatus: 'clean' }));
    h.signUrl.mockImplementation(
      async (_path, mode, options) => `https://${options?.audience === 'browser' ? 'public' : 'private'}.test/${mode}`
    );
  });

  it('persists a private GET URL for inline content and returns a separate browser GET', async () => {
    const { res, json } = makeRes();
    await run(body({ content: 'owned text' }), res);
    expect(h.fabFileCreate.mock.calls[0][0].fileUrl).toBe('https://private.test/get');
    expect(json.mock.calls[0][0].fileUrl).toBe('https://public.test/get');
    expect(h.signUrl.mock.calls[0][1]).toBe('get');
  });

  it.each(['tmp', 'temp', 'x/backups', 'text-edit-backups'])(
    'ignores a caller-chosen %s prefix, so the object stays under a tracked key',
    async prefix => {
      const { res } = makeRes();
      await run(body({ prefix }), res);
      const persisted = h.fabFileCreate.mock.calls[0][0] as { filePath: string; prefix?: string };
      expect(persisted.prefix).toBeUndefined();
      expect(persisted.filePath).toMatch(/^[0-9a-f-]{36}\.txt$/);
    }
  );

  it('keeps URL-less uploads on private PUT signing without a browser GET', async () => {
    const { res, json } = makeRes();
    await run(body(), res);
    expect(json.mock.calls[0][0].presignedUrl).toBe('https://private.test/put');
    expect(json.mock.calls[0][0].fileUrl).toBeUndefined();
    expect(h.signUrl).toHaveBeenCalledTimes(1);
    expect(h.signUrl.mock.calls[0][1]).toBe('put');
    // Bound to the declared fileSize, so S3 refuses a PUT of any other length.
    expect(h.signUrl.mock.calls[0][2]).toMatchObject({ ContentLength: 10 });
  });
});

describe('POST /api/files/createFabFile - admin modal video', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.lakeFind.mockResolvedValue([]);
    h.userFindById.mockResolvedValue({ id: 'u1', isAdmin: true, storageLimit: 1e12, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
    h.signUrl.mockResolvedValue('https://signed.test/put');
  });

  const mp4 = (overrides: Record<string, unknown> = {}) =>
    body({ fileName: 'demo.mp4', mimeType: 'video/mp4', fileSize: 1000, purpose: 'modal-media', ...overrides });
  const asAdmin = { user: { id: 'u1', isAdmin: true } };

  it('admits an admin mp4 under the server-chosen modals prefix', async () => {
    const { res } = makeRes();
    await run(mp4(), res, asAdmin);

    const persisted = h.fabFileCreate.mock.calls[0][0] as { mimeType: string; filePath: string };
    expect(persisted.mimeType).toBe('video/mp4');
    expect(persisted.filePath).toMatch(/^modals\/.+\.mp4$/);
  });

  it('stores an admin modal poster under the modals prefix with the usual type rules', async () => {
    const { res } = makeRes();
    await run(mp4({ fileName: 'poster.jpg', mimeType: 'image/jpeg' }), res, asAdmin);

    const persisted = h.fabFileCreate.mock.calls[0][0] as { filePath: string };
    expect(persisted.filePath).toMatch(/^modals\/.+\.jpg$/);
  });

  it('ignores the purpose for a non-admin poster', async () => {
    const { res } = makeRes();
    await run(mp4({ fileName: 'poster.jpg', mimeType: 'image/jpeg' }), res, { user: { id: 'u1', isAdmin: false } });

    const persisted = h.fabFileCreate.mock.calls[0][0] as { filePath: string };
    expect(persisted.filePath).not.toMatch(/^modals\//);
  });

  it('returns a mediaUrl for an admin modal-media upload that the modal video schema accepts', async () => {
    const { res, json } = makeRes();
    await run(mp4(), res, asAdmin);

    const sent = json.mock.calls[0][0] as { mediaUrl: string; filePath: string };
    expect(sent.mediaUrl.endsWith(sent.filePath)).toBe(true);
    expect(sent.mediaUrl).toContain('test-fab-bucket');
    const schema = createModalVideoSchema({ extraOrigins: deploymentMediaOrigins() });
    expect(schema.safeParse({ landscapeUrl: sent.mediaUrl }).success).toBe(true);
  });

  it('omits mediaUrl for a normal upload', async () => {
    const { res, json } = makeRes();
    await run(body(), res, asAdmin);

    expect(json.mock.calls[0][0]).not.toHaveProperty('mediaUrl');
  });

  it.each([
    ['a non-admin', mp4(), { user: { id: 'u1', isAdmin: false } }],
    ['an admin naming the prefix instead of the purpose', mp4({ purpose: undefined, prefix: 'modals' }), asAdmin],
    ['an admin claiming another video type', mp4({ mimeType: 'video/quicktime' }), asAdmin],
    ['an admin with a non-mp4 name', mp4({ fileName: 'demo.mov' }), asAdmin],
  ])('refuses %s with the usual 400', async (_case, payload, overrides) => {
    const { res } = makeRes();
    await expect(run(payload, res, overrides)).rejects.toThrow(/is not supported/);
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('rejects a purpose it does not know', async () => {
    const { res } = makeRes();
    await expect(run(mp4({ purpose: 'other' }), res, asAdmin)).rejects.toThrow();
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });
});

describe('POST /api/files/createFabFile - release-notes:write key', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.lakeFind.mockResolvedValue([]);
    h.userFindById.mockResolvedValue({ id: 'u1', isAdmin: true, storageLimit: 1e12, currentStorageSize: 0 });
    h.fabFileCreate.mockImplementation(async data => ({ id: 'f1', ...data }));
    h.signUrl.mockResolvedValue('https://signed.test/put');
  });

  const releaseKey = { apiKeyInfo: { scopes: ['release-notes:write'] } };
  const mp4 = (overrides: Record<string, unknown> = {}) =>
    body({ fileName: 'demo.mp4', mimeType: 'video/mp4', fileSize: 1000, purpose: 'modal-media', ...overrides });

  it("uploads What's New media for an admin user under the modals prefix", async () => {
    const { res, json } = makeRes();
    await run(mp4(), res, { ...releaseKey, user: { id: 'u1', isAdmin: true } });

    const persisted = h.fabFileCreate.mock.calls[0][0] as { filePath: string };
    expect(persisted.filePath).toMatch(/^modals\/.+\.mp4$/);
    expect(json.mock.calls[0][0]).toHaveProperty('mediaUrl');
  });

  it("uploads What's New media for a key whose admin owner has the role withheld", async () => {
    const { res } = makeRes();
    await run(mp4(), res, { ...releaseKey, user: withholdAdminRole({ id: 'u1', isAdmin: true }) });
    expect(h.fabFileCreate).toHaveBeenCalled();
  });

  it.each([
    ['without a purpose', body(), { user: { id: 'u1', isAdmin: true } }],
    ['for a non-admin user', mp4(), { user: { id: 'u1', isAdmin: false } }],
  ])('refuses any other file %s with a 403', async (_case, payload, overrides) => {
    const { res } = makeRes();
    await expect(run(payload, res, { ...releaseKey, ...overrides })).rejects.toMatchObject({ statusCode: 403 });
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it('refuses another purpose at validation, before any upload', async () => {
    const { res } = makeRes();
    await expect(
      run(mp4({ purpose: 'other' }), res, { ...releaseKey, user: { id: 'u1', isAdmin: true } })
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it("refuses a type outside the What's New media types", async () => {
    const { res } = makeRes();
    await expect(
      run(mp4({ fileName: 'page.html', mimeType: 'text/html' }), res, {
        ...releaseKey,
        user: { id: 'u1', isAdmin: true },
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  // The service stores the type and key extension it resolves from the file name, so an allowed claim
  // on another name would land as that other type under the public modals prefix.
  it.each([
    ['page.html', 'image/png'],
    ['x.png.html', 'image/png'],
    ['icon.svg', 'image/png'],
    ['doc.pdf', 'video/mp4'],
    ['notes.txt', 'image/jpeg'],
    ['poster.png', 'image/jpeg'],
    ['noext', 'image/png'],
    ['payload.', 'image/png'],
    ['demo.mp4', 'constructor'],
  ])('refuses %s claimed as %s with a 403', async (fileName, mimeType) => {
    const { res } = makeRes();
    await expect(
      run(mp4({ fileName, mimeType }), res, { ...releaseKey, user: { id: 'u1', isAdmin: true } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(h.fabFileCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['demo.mp4', 'video/mp4'],
    ['poster.jpg', 'image/jpeg'],
    ['poster.jpeg', 'image/jpeg'],
    ['POSTER.PNG', 'image/png'],
    ['poster.webp', 'image/webp'],
  ])('stores %s claimed as %s as that type', async (fileName, mimeType) => {
    const { res } = makeRes();
    await run(mp4({ fileName, mimeType }), res, { ...releaseKey, user: { id: 'u1', isAdmin: true } });
    const persisted = h.fabFileCreate.mock.calls[0][0] as { mimeType: string; filePath: string };
    expect(persisted.mimeType).toBe(mimeType);
    expect(persisted.filePath).toMatch(/^modals\//);
  });

  it("persists none of the fields a What's New upload has no use for", async () => {
    const { res } = makeRes();
    await run(
      mp4({
        system: true,
        systemPriority: 9,
        sessionId: 'session-1',
        tags: [{ name: 'x', strength: 1 }],
        content: 'inline',
        batchId: 'batch-1',
      }),
      res,
      { ...releaseKey, user: { id: 'u1', isAdmin: true } }
    );

    const persisted = h.fabFileCreate.mock.calls[0][0] as Record<string, unknown>;
    for (const field of ['system', 'systemPriority', 'sessionId', 'tags', 'content', 'batchId']) {
      expect(persisted[field], field).toBeUndefined();
    }
    expect(h.batchFindById).not.toHaveBeenCalled();
  });

  it('leaves a files:write key free to upload an ordinary file', async () => {
    const { res } = makeRes();
    await run(body(), res, { apiKeyInfo: { scopes: ['files:write'] }, user: { id: 'u1', isAdmin: true } });
    expect(h.fabFileCreate).toHaveBeenCalled();
  });
});
