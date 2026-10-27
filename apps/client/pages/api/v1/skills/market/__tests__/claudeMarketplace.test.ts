// @vitest-environment node
/**
 * Route tests for the Skill Market's Claude Code plugin feed: claude-marketplace.json and
 * [id]/claude-plugin.zip. `baseApi` is stubbed (so the skills:read scope gate is not exercised
 * here; the contract declares it), but the contract router, the visibility helpers in
 * server/skillMarket/market.ts and the zip builder run for real against mocked models.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, getClaudeMarketplaceContract, getClaudePluginZipContract } from '@bike4mind/common';
import { decideScopeGate } from '@server/middlewares/apiKeyScopeGate';

const {
  mockFind,
  mockFindOne,
  mockFindById,
  mockAssignName,
  mockFindVersion,
  mockFindPinnedVersion,
  mockFindVersions,
  mockMemberOrgs,
  mockAdminOrgs,
  mockFindOrg,
  baseApiOptions,
} = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockFindOne: vi.fn(),
  mockFindById: vi.fn(),
  mockAssignName: vi.fn(),
  mockFindVersion: vi.fn(),
  mockFindPinnedVersion: vi.fn(),
  mockFindVersions: vi.fn(),
  mockMemberOrgs: vi.fn(),
  mockAdminOrgs: vi.fn(),
  mockFindOrg: vi.fn(),
  baseApiOptions: [] as Array<{ requiredScopes?: Parameters<typeof decideScopeGate>[0] }>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: (options: { requiredScopes?: Parameters<typeof decideScopeGate>[0] }) => {
    baseApiOptions.push(options);
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
    return { get: compose };
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({
  SkillListing: { find: mockFind, findOne: mockFindOne, findById: mockFindById },
  assignClaudePluginName: mockAssignName,
  SkillListingVersion: { findById: mockFindVersion, findOne: mockFindPinnedVersion, find: mockFindVersions },
  adminSettingsRepository: {},
  inboxRepository: {},
}));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findMembershipOrgIds: mockMemberOrgs,
    findIdsAdministeredBy: mockAdminOrgs,
    findById: mockFindOrg,
  },
}));

process.env.APP_URL = 'https://app.example.test/';

const { default: feedHandler } = await import('@pages/api/v1/skills/market/claude-marketplace.json');
const zipBaseApiIndex = baseApiOptions.length;
const { default: zipHandler } = await import('@pages/api/v1/skills/market/[id]/claude-plugin.zip');
const { publicAppUrl } = await import('@server/utils/validators');

const ORG_ID = '65a0000000000000000000aa';
const LISTING_A = '65b000000000000000000001';
const LISTING_B = '65b000000000000000000002';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const doc = <T extends object>(json: T) => ({ toJSON: () => json });

const listing = (id: string, overrides: object = {}) => ({
  id,
  name: 'review-pr',
  description: 'Review a PR',
  status: 'approved',
  deletedAt: null,
  hiddenByReports: false,
  visibility: 'organization',
  organizationId: ORG_ID,
  shareToken: 'tok',
  currentApprovedVersionId: `v-${id}`,
  currentVersion: 3,
  claudePluginName: id === LISTING_A ? 'review-pr' : `review-pr-${id.slice(-6)}`,
  ...overrides,
});

const version = (id: string, name = 'review-pr') => ({
  id: `v-${id}`,
  version: 3,
  reviewStatus: 'approved',
  snapshot: {
    name,
    description: 'Review a PR',
    body: 'Check the diff.',
    allowedTools: ['web_search'],
  },
});

type MarketplaceRequest = Parameters<typeof feedHandler>[0] & Parameters<typeof zipHandler>[0];
type MarketplaceResponse = Parameters<typeof feedHandler>[1];

async function call(
  handler: typeof feedHandler | typeof zipHandler,
  query: Record<string, string>,
  headers: Record<string, string> = {}
) {
  const { req, res } = createMocks<MarketplaceRequest, MarketplaceResponse>({ method: 'GET', query, headers });
  Object.assign(req, { user: { id: 'u1' }, logger });
  try {
    await handler(req, res);
  } catch (err) {
    return { error: err as { statusCode?: number }, res };
  }
  return { error: null, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMemberOrgs.mockResolvedValue([ORG_ID]);
  mockAdminOrgs.mockResolvedValue([]);
  mockFindOrg.mockResolvedValue({ id: ORG_ID, name: 'Acme Labs' });
  mockFindPinnedVersion.mockImplementation(async () => doc(version(LISTING_A)));
  mockFindVersion.mockImplementation(async (versionId: string) => doc(version(versionId.slice(2))));
  mockFindVersions.mockImplementation(async ({ _id }: { _id: { $in: string[] } }) =>
    _id.$in.map(versionId => doc(version(versionId.slice(2))))
  );
  mockFind.mockReturnValue({ sort: async () => [doc(listing(LISTING_A)), doc(listing(LISTING_B))] });
  mockFindOne.mockImplementation(async ({ _id }: { _id: string }) => doc(listing(_id)));
});

async function callWithReq(query: Record<string, string>, headers: Record<string, string>) {
  const { req, res } = createMocks<MarketplaceRequest, MarketplaceResponse>({ method: 'GET', query, headers });
  Object.assign(req, { user: { id: 'u1' }, logger });
  await feedHandler(req, res);
  return { req, res };
}

const zipOf = async (id: string) => {
  const { error, res } = await call(zipHandler, { id });
  expect(error).toBeNull();
  return res._getData() as Buffer;
};

describe('GET /api/v1/skills/market/claude-marketplace.json', () => {
  it("lists the org's approved Organization listings with archive sources", async () => {
    const { error, res } = await call(feedHandler, { orgId: ORG_ID });
    expect(error).toBeNull();
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');

    const filter = mockFind.mock.calls[0][0];
    expect(filter).toMatchObject({ status: 'approved', visibility: 'organization', organizationId: ORG_ID });

    const body = res._getJSONData();
    expect(body.name).toBe(`b4m-org-${ORG_ID}`);
    expect(body.forceRemoveDeletedPlugins).toBe(true);
    expect(body.plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr', 'review-pr-000002']);
    expect(body.plugins[0]).toMatchObject({
      version: '3',
      description: 'Review a PR',
      source: {
        source: 'archive',
        url: `https://app.example.test/api/v1/skills/market/${LISTING_A}/claude-plugin.zip?version=3`,
      },
    });
  });

  it('pins each plugin to the exact bytes the zip route serves', async () => {
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    const [plugin] = res._getJSONData().plugins;
    const zip = await zipOf(LISTING_A);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(plugin.source.sha256);
  });

  // The Team marketplace tab builds the feed URL from serverConfigPublic's apiUrl (publicAppUrl), so
  // every zip URL must share that origin or Claude Code fetches the zips from a different host.
  it.each([
    ['a deployed APP_URL', 'https://app.example.test/', 'evil.example.test', 'https://app.example.test'],
    ['a localhost APP_URL on another port', 'http://localhost:3000', 'localhost:4321', 'http://localhost:4321'],
  ])('serves zip URLs on the same origin as the tab feed URL, on %s', async (_label, appUrl, host, origin) => {
    const saved = process.env.APP_URL;
    process.env.APP_URL = appUrl;
    try {
      const { res, req } = await callWithReq({ orgId: ORG_ID }, { host });
      expect(new URL(publicAppUrl(req)).origin).toBe(origin);
      const urls = res._getJSONData().plugins.map((p: { source: { url: string } }) => new URL(p.source.url).origin);
      expect(urls).toEqual([origin, origin]);
    } finally {
      process.env.APP_URL = saved;
    }
  });

  it('fails closed when the membership lookup fails', async () => {
    mockMemberOrgs.mockRejectedValueOnce(new Error('membership unavailable'));
    const { error } = await call(feedHandler, { orgId: ORG_ID });
    expect(error).toBeInstanceOf(Error);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('retains the advertised bytes when a newer version is approved', async () => {
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    const [plugin] = res._getJSONData().plugins;
    mockFindOne.mockResolvedValue(doc(listing(LISTING_A, { currentVersion: 4, currentApprovedVersionId: 'new-v4' })));
    mockFindVersion.mockResolvedValue(doc({ ...version(LISTING_A, 'New name'), version: 4 }));
    const url = new URL(plugin.source.url);
    const { error, res: archive } = await call(zipHandler, {
      id: LISTING_A,
      version: url.searchParams.get('version')!,
    });
    expect(error).toBeNull();
    expect(mockFindPinnedVersion).toHaveBeenCalledWith({ listingId: LISTING_A, version: 3 });
    expect(createHash('sha256').update(archive._getData()).digest('hex')).toBe(plugin.source.sha256);
  });

  it('refuses an org the caller is not a member of', async () => {
    mockMemberOrgs.mockResolvedValue([]);
    const { error } = await call(feedHandler, { orgId: ORG_ID });
    expect(error?.statusCode).toBe(403);
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("skips a listing whose current version is no longer approved, without renaming the other's plugin", async () => {
    mockFindVersions.mockImplementation(async ({ _id }: { _id: { $in: string[] } }) =>
      _id.$in.map(versionId =>
        doc({ ...version(versionId.slice(2)), reviewStatus: versionId.endsWith('1') ? 'superseded' : 'approved' })
      )
    );
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    expect(res._getJSONData().plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr-000002']);
  });

  it('serves the stored plugin name after a version renames the skill', async () => {
    mockFind.mockReturnValue({ sort: async () => [doc(listing(LISTING_A, { name: 'Code Critic' }))] });
    mockFindVersions.mockResolvedValue([doc(version(LISTING_A, 'Code Critic'))]);
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    expect(res._getJSONData().plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr']);
  });

  it('keeps the marketplace name when the org is renamed', async () => {
    const { res: before } = await call(feedHandler, { orgId: ORG_ID });
    mockFindOrg.mockResolvedValue({ id: ORG_ID, name: 'Acme Robotics' });
    const { res: after } = await call(feedHandler, { orgId: ORG_ID });
    expect(after._getJSONData().name).toBe(before._getJSONData().name);
    expect(after._getJSONData().name).toBe(`b4m-org-${ORG_ID}`);
    expect(after._getJSONData().owner.name).toBe('Acme Robotics');
  });

  it('names a listing approved before names were stored, then serves the stored name', async () => {
    mockFind.mockReturnValue({ sort: async () => [doc(listing(LISTING_A, { claudePluginName: undefined }))] });
    mockFindById.mockReturnValue({ select: async () => ({ claudePluginName: 'review-pr' }) });
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    expect(mockAssignName).toHaveBeenCalledWith(LISTING_A, 'review-pr');
    expect(res._getJSONData().plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr']);
  });

  it('omits a listing that still has no stored name rather than serve an unstable one', async () => {
    mockFind.mockReturnValue({ sort: async () => [doc(listing(LISTING_A, { claudePluginName: undefined }))] });
    mockFindById.mockReturnValue({ select: async () => null });
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    expect(res._getJSONData().plugins).toEqual([]);
  });

  it('omits only the listing whose naming throws, serving the rest', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFind.mockReturnValue({
      sort: async () => [doc(listing(LISTING_A, { claudePluginName: undefined })), doc(listing(LISTING_B))],
    });
    mockAssignName.mockRejectedValueOnce(new Error('boom'));
    const { error, res } = await call(feedHandler, { orgId: ORG_ID });
    expect(error).toBeNull();
    expect(res._getJSONData().plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr-000002']);
  });
});

describe('GET /api/v1/skills/market/{id}/claude-plugin.zip', () => {
  it('serves byte-identical zips holding the stamped SKILL.md', async () => {
    const first = await zipOf(LISTING_A);
    const second = await zipOf(LISTING_A);
    expect(first.equals(second)).toBe(true);
    // ZIP local header time/date fields: midnight 2000-01-01 in every server timezone.
    expect(first.readUInt16LE(10)).toBe(0);
    expect(first.readUInt16LE(12)).toBe((20 << 9) | (1 << 5) | 1);

    // Stored (uncompressed), so the SKILL.md text is readable in the archive bytes.
    const text = first.toString('utf8');
    expect(text).toContain('skills/review-pr/SKILL.md');
    expect(text).toContain(`# Bike4Mind-Source: https://app.example.test/skills/market/${LISTING_A}`);
    expect(text).toContain('# Version: 3');
    expect(text).toContain('Third-party skill from the Bike4Mind Skill Market');
    expect(text).not.toContain('allowed-tools');
    expect(text).not.toContain('# Exported:');
  });

  it("carries the author's Claude Code allowed-tools into the plugin's SKILL.md", async () => {
    const v = version(LISTING_A);
    mockFindVersion.mockResolvedValue(
      doc({ ...v, snapshot: { ...v.snapshot, claudeCodeAllowedTools: ['Bash(git:*)', 'Read'] } })
    );
    const text = (await zipOf(LISTING_A)).toString('utf8');
    expect(text).toContain('allowed-tools: Bash(git:*), Read');
    expect(text).not.toContain('web_search');
  });

  it("404s a caller who is not a member of the listing's org", async () => {
    mockMemberOrgs.mockResolvedValue(['65a0000000000000000000bb']);
    const { error } = await call(zipHandler, { id: LISTING_A });
    expect(error?.statusCode).toBe(404);
    expect(mockFindVersion).not.toHaveBeenCalled();
  });

  it('404s a pinned version that does not belong to the listing', async () => {
    mockFindPinnedVersion.mockResolvedValueOnce(null);
    const { error } = await call(zipHandler, { id: LISTING_A, version: '3' });
    expect(error?.statusCode).toBe(404);
    expect(mockFindPinnedVersion).toHaveBeenCalledWith({ listingId: LISTING_A, version: 3 });
  });

  it('404s a pinned version whose approval was revoked', async () => {
    mockFindPinnedVersion.mockResolvedValueOnce(doc({ ...version(LISTING_A), reviewStatus: 'rejected' }));
    const { error } = await call(zipHandler, { id: LISTING_A, version: '3' });
    expect(error?.statusCode).toBe(404);
  });

  it.each(['0', '-1', '1.5', 'NaN', ''])('rejects invalid version %j', async version => {
    const { error } = await call(zipHandler, { id: LISTING_A, version });
    expect(error?.statusCode).toBe(400);
    expect(mockFindPinnedVersion).not.toHaveBeenCalled();
  });

  it('404s a listing whose current version is no longer approved', async () => {
    mockFindOne.mockResolvedValue(doc(listing(LISTING_A)));
    mockFindVersion.mockResolvedValue(doc({ ...version('1'), reviewStatus: 'superseded' }));
    const { error } = await call(zipHandler, { id: LISTING_A });
    expect(error?.statusCode).toBe(404);
  });

  it.each([
    ['a public listing', { visibility: 'public' }],
    ['an unlisted listing', { visibility: 'unlisted' }],
    ["another org's listing", { organizationId: '65a0000000000000000000bb' }],
    ['a delisted listing', { status: 'delisted' }],
    ['a hidden listing', { hiddenByReports: true }],
  ])('404s %s', async (_label, overrides) => {
    mockFindOne.mockResolvedValue(doc(listing(LISTING_A, overrides)));
    const { error } = await call(zipHandler, { id: LISTING_A });
    expect(error?.statusCode).toBe(404);
  });
});

describe('marketplace API key confinement', () => {
  it.each([getClaudeMarketplaceContract, getClaudePluginZipContract])(
    'requires skills:read on $operationId',
    contract => {
      expect(contract.scopes).toEqual([ApiKeyScope.SKILLS_READ]);
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.SKILLS_READ], new Set())).toEqual({ outcome: 'allow' });
      expect(decideScopeGate(contract.scopes, [ApiKeyScope.READ_NOTEBOOKS], new Set())).toEqual({ outcome: 'deny' });
    }
  );

  // Distinct from the contract check above: this is the scope list the zip route actually hands
  // baseApi (whose apiKeyAuth runs decideScopeGate), so a route wired to the wrong contract fails.
  it('wires skills:read into the zip route, which denies a key without it', () => {
    const { requiredScopes } = baseApiOptions[zipBaseApiIndex];
    expect(requiredScopes).toEqual([ApiKeyScope.SKILLS_READ]);
    expect(decideScopeGate(requiredScopes, [ApiKeyScope.READ_NOTEBOOKS], new Set())).toEqual({ outcome: 'deny' });
  });

  it('keeps the key off unrelated routes, including during scope staging', () => {
    expect(decideScopeGate(undefined, [ApiKeyScope.SKILLS_READ], new Set())).toEqual({ outcome: 'deny' });
    expect(decideScopeGate([ApiKeyScope.AI_CHAT], [ApiKeyScope.SKILLS_READ], new Set([ApiKeyScope.AI_CHAT]))).toEqual({
      outcome: 'deny',
    });
  });
});
