// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError, HttpStatus } from '@bike4mind/common';

// Capture the POST handler off the chain. This route's gate was swapped in this change and
// `orgId` reaches it from `req.query.id` under a non-null assertion, so an absent id is a real
// request shape the gate has to answer for.
const { routeHandlers } = vi.hoisted(() => ({
  routeHandlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      post(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.POST = fn;
        return chain;
      },
    };
    return chain;
  },
}));

// The module calls initializeSlackPackage() at import time, which wires the real server
// dependency graph (sst Resource, ability, storage, ...). Nothing here needs it.
vi.mock('@server/integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: vi.fn() }));

// Deliberately NOT mocking verifyOrgOwner, matching the sibling index.test.ts: the behaviour the
// gate swap changes lives INSIDE the helper, so mocking it would assert the mock. Stubbing the
// repository exercises route + helper together and pins the document contract between them.
const mockOrgFindById = vi.fn();
const mockFindByOrganizationId = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => mockOrgFindById(...args),
  },
  orgSlackWorkspaceRepository: {
    findByOrganizationId: (...args: unknown[]) => mockFindByOrganizationId(...args),
  },
}));

// orgAccess pulls in resolveActiveOrg, which imports the NON-/infra barrel; left real it would
// reach the actual mongoose models. Nothing in this route calls through it.
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

const mockGetCredentials = vi.fn();
const mockGenerateStateToken = vi.fn();
const mockBuildOAuthUrl = vi.fn();
vi.mock('@bike4mind/slack', () => ({
  getSystemSlackAppCredentials: (...args: unknown[]) => mockGetCredentials(...args),
  generateOrgSlackConnectStateToken: (...args: unknown[]) => mockGenerateStateToken(...args),
  buildOrgSlackOAuthUrl: (...args: unknown[]) => mockBuildOAuthUrl(...args),
}));

// issueStateNonce SETS A COOKIE on the response, so it is a side effect a refused caller must
// never trigger - not merely a value the handler happens not to use.
const mockIssueStateNonce = vi.fn();
vi.mock('@server/auth/oauthFlowCookie', () => ({
  issueStateNonce: (...args: unknown[]) => mockIssueStateNonce(...args),
  NONCE_SLOT: { orgSlackConnect: 'org-slack-connect' },
}));

import '../connect';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const STRANGER = '650000000000000000000333';

// `id` is the Mongoose virtual: always the canonical lowercase spelling, whatever casing the
// request used to reach the document.
const org = { id: ORG, userId: OWNER };

// `null` means "send no id at all" - passing `undefined` would hit the default parameter and
// quietly send ORG, turning the absent-id case into a second happy-path test.
function makeReq(user: { id: string; isAdmin: boolean }, orgId: string | null = ORG) {
  const { req, res } = createMocks({ method: 'POST' });
  (req as Record<string, unknown>).query = orgId === null ? {} : { id: orgId };
  (req as Record<string, unknown>).user = user;
  (req as Record<string, unknown>).headers = { host: 'app.example.com', 'x-forwarded-proto': 'https' };
  return { req, res };
}

const owner = { id: OWNER, isAdmin: false };
const stranger = { id: STRANGER, isAdmin: false };
const admin = { id: STRANGER, isAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgFindById.mockResolvedValue(org);
  mockFindByOrganizationId.mockResolvedValue(null);
  mockGetCredentials.mockResolvedValue({ clientId: 'client_1' });
  mockGenerateStateToken.mockReturnValue('state_token');
  mockBuildOAuthUrl.mockReturnValue('https://slack.com/oauth/v2/authorize?state=state_token');
  mockIssueStateNonce.mockReturnValue('nonce_hash');
});

describe('POST /api/organizations/[id]/integrations/slack/connect', () => {
  it('returns an OAuth url to the org owner', async () => {
    const { req, res } = makeReq(owner);

    await routeHandlers.POST(req, res);

    expect(mockOrgFindById).toHaveBeenCalledWith(ORG);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ url: 'https://slack.com/oauth/v2/authorize?state=state_token' });
  });

  it('returns an OAuth url to a platform admin', async () => {
    const { req, res } = makeReq(admin);

    await routeHandlers.POST(req, res);

    expect(res.statusCode).toBe(200);
  });

  // Binds the OAuth flow to this browser AND this tenant. The callback trusts the state payload,
  // so the org id and user id carried here are what end up on the persisted workspace row.
  it('binds the state token to the org, the caller and the nonce cookie', async () => {
    const { req, res } = makeReq(owner);

    await routeHandlers.POST(req, res);

    expect(mockIssueStateNonce).toHaveBeenCalledWith(res, 'org-slack-connect');
    expect(mockGenerateStateToken).toHaveBeenCalledWith(ORG, OWNER, 'nonce_hash');
    expect(mockBuildOAuthUrl).toHaveBeenCalledWith(
      'client_1',
      expect.stringContaining('/api/slack/oauth/org-connect/callback'),
      'state_token'
    );
  });

  // The load-bearing one. Without a gate here any authenticated caller could start a Slack OAuth
  // flow against a tenant they have no relationship to; a dropped or renamed gate call is
  // invisible to tsc, so this is what fails if the line goes away.
  it('404s a caller who does not own the org, minting nothing', async () => {
    const { req, res } = makeReq(stranger);

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      statusCode: HttpStatus.NotFound,
      message: 'Organization not found',
    });

    // The gate must precede the lookup, or a non-owner learns whether the org has Slack wired up.
    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
    expect(mockIssueStateNonce).not.toHaveBeenCalled();
    expect(mockGenerateStateToken).not.toHaveBeenCalled();
  });

  it('404s when the org does not exist, identically to a non-owner', async () => {
    mockOrgFindById.mockResolvedValue(null);
    const { req, res } = makeReq(stranger);

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });

    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
  });

  // The documented behaviour delta of the gate swap: the deleted inline check handed the raw id to
  // findById and answered 404; the shared helper validates first and answers 400.
  it('400s a malformed org id without touching the database', async () => {
    const { req, res } = makeReq(owner, 'not-an-object-id');

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Invalid organization ID',
    });

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
    expect(mockIssueStateNonce).not.toHaveBeenCalled();
  });

  // `const orgId = req.query.id!` asserts a value the router does not guarantee. The gate's
  // `!orgId` arm is what actually answers for it.
  it('400s an absent org id without touching the database', async () => {
    const { req, res } = makeReq(owner, null);

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Invalid organization ID',
    });

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockIssueStateNonce).not.toHaveBeenCalled();
  });

  it('400s when a workspace is already connected, minting nothing', async () => {
    mockFindByOrganizationId.mockResolvedValue({ id: 'ws_1', organizationId: ORG });
    const { req, res } = makeReq(owner);

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      statusCode: HttpStatus.BadRequest,
      message: 'A Slack workspace is already connected to this organization',
    });

    expect(mockIssueStateNonce).not.toHaveBeenCalled();
    expect(mockBuildOAuthUrl).not.toHaveBeenCalled();
  });

  it('400s when Slack app credentials are not configured, minting no nonce', async () => {
    mockGetCredentials.mockResolvedValue(null);
    const { req, res } = makeReq(owner);

    await expect(routeHandlers.POST(req, res)).rejects.toMatchObject({
      statusCode: HttpStatus.BadRequest,
      message: 'Slack integration is not configured. Please contact support.',
    });

    expect(mockIssueStateNonce).not.toHaveBeenCalled();
  });

  // `isValidObjectId` accepts uppercase hex and `findById` casts it, but OrgSlackWorkspace
  // .organizationId is a `type: String` matched byte-exactly and carries a UNIQUE index. Keying
  // off the raw query string let an owner's uppercase spelling miss the already-connected guard
  // and ride the state token into the callback, which writes it verbatim - a second workspace row
  // for one org, past the index meant to forbid that. Both sites must read the gated document.
  it('canonicalises an uppercase-hex org id at the guard and in the state token', async () => {
    mockFindByOrganizationId.mockResolvedValue(null);
    const { req, res } = makeReq(owner, ORG.toUpperCase());

    await routeHandlers.POST(req, res);

    expect(mockFindByOrganizationId).toHaveBeenCalledWith(ORG);
    expect(mockGenerateStateToken).toHaveBeenCalledWith(ORG, OWNER, 'nonce_hash');
    expect(res.statusCode).toBe(200);
  });
});
