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

const { mockFind, mockFindOne, mockFindVersion, mockFindVersions, mockMemberOrgs, mockAdminOrgs, mockFindOrg } =
  vi.hoisted(() => ({
    mockFind: vi.fn(),
    mockFindOne: vi.fn(),
    mockFindVersion: vi.fn(),
    mockFindVersions: vi.fn(),
    mockMemberOrgs: vi.fn(),
    mockAdminOrgs: vi.fn(),
    mockFindOrg: vi.fn(),
  }));

vi.mock('@server/middlewares/baseApi', () => ({
  methodNotAllowedHandler: () => (_req: unknown, res: { status: (n: number) => { end: () => void } }) =>
    res.status(405).end(),
  baseApi: () => {
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
vi.mock('@server/middlewares/rateLimit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@bike4mind/database', () => ({
  SkillListing: { find: mockFind, findOne: mockFindOne },
  SkillListingVersion: { findById: mockFindVersion, find: mockFindVersions },
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
const { default: zipHandler } = await import('@pages/api/v1/skills/market/[id]/claude-plugin.zip');

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
  ...overrides,
});

const version = (id: string) => ({
  id: `v-${id}`,
  version: 3,
  reviewStatus: 'approved',
  snapshot: {
    name: 'review-pr',
    description: 'Review a PR',
    body: 'Check the diff.',
    allowedTools: ['web_search'],
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the contract router's param type carries prelude-only fields
async function call(handler: any, query: Record<string, string>) {
  const { req, res } = createMocks({ method: 'GET', query });
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
  mockFindVersion.mockImplementation(async (versionId: string) => doc(version(versionId.slice(2))));
  mockFindVersions.mockImplementation(async ({ _id }: { _id: { $in: string[] } }) =>
    _id.$in.map(versionId => doc(version(versionId.slice(2))))
  );
  mockFind.mockReturnValue({ sort: async () => [doc(listing(LISTING_A)), doc(listing(LISTING_B))] });
  mockFindOne.mockImplementation(async ({ _id }: { _id: string }) => doc(listing(_id)));
});

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
    expect(body.name).toBe('b4m-acme-labs');
    expect(body.forceRemoveDeletedPlugins).toBe(true);
    expect(body.plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr-00000001', 'review-pr-00000002']);
    expect(body.plugins[0]).toMatchObject({
      version: '3',
      description: 'Review a PR',
      source: {
        source: 'archive',
        url: `https://app.example.test/api/v1/skills/market/${LISTING_A}/claude-plugin.zip`,
      },
    });
  });

  it('pins each plugin to the exact bytes the zip route serves', async () => {
    const { res } = await call(feedHandler, { orgId: ORG_ID });
    const [plugin] = res._getJSONData().plugins;
    const zip = await zipOf(LISTING_A);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(plugin.source.sha256);
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
    expect(res._getJSONData().plugins.map((p: { name: string }) => p.name)).toEqual(['review-pr-00000002']);
  });
});

describe('GET /api/v1/skills/market/{id}/claude-plugin.zip', () => {
  it('serves byte-identical zips holding the stamped SKILL.md', async () => {
    const first = await zipOf(LISTING_A);
    const second = await zipOf(LISTING_A);
    expect(first.equals(second)).toBe(true);

    // Stored (uncompressed), so the SKILL.md text is readable in the archive bytes.
    const text = first.toString('utf8');
    expect(text).toContain('skills/review-pr/SKILL.md');
    expect(text).toContain(`# Bike4Mind-Source: https://app.example.test/skills/market/${LISTING_A}`);
    expect(text).toContain('# Version: 3');
    expect(text).toContain('Third-party skill from the Bike4Mind Skill Market');
    expect(text).not.toContain('allowed-tools');
    expect(text).not.toContain('# Exported:');
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
  ])('404s %s', async (_label, overrides) => {
    mockFindOne.mockResolvedValue(doc(listing(LISTING_A, overrides)));
    const { error } = await call(zipHandler, { id: LISTING_A });
    expect(error?.statusCode).toBe(404);
  });
});
