// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, NotFoundError, HttpStatus } from '@bike4mind/common';

// Capture the per-method handlers off the chain so each arm can be driven independently. The
// DELETE arm is the one that matters: it is destructive and its gate was swapped in this change.
const { routeHandlers } = vi.hoisted(() => ({
  routeHandlers: {} as Record<string, (req: unknown, res: unknown) => Promise<unknown>>,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      get(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.GET = fn;
        return chain;
      },
      delete(fn: (req: unknown, res: unknown) => Promise<unknown>) {
        routeHandlers.DELETE = fn;
        return chain;
      },
    };
    return chain;
  },
}));

// Deliberately NOT mocking verifyOrgOwner. The one behaviour this route's gate swap changes -
// a malformed id answering 400 where the deleted inline helper answered 404 - lives inside the
// shared helper, so mocking it would assert the mock rather than the delta. Stubbing the
// repository instead exercises route + helper together, which also pins the document contract
// between them.
const mockOrgFindById = vi.fn();
const mockFindByOrganizationId = vi.fn();
const mockWorkspaceDelete = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {
    findById: (...args: unknown[]) => mockOrgFindById(...args),
  },
  orgSlackWorkspaceRepository: {
    findByOrganizationId: (...args: unknown[]) => mockFindByOrganizationId(...args),
    delete: (...args: unknown[]) => mockWorkspaceDelete(...args),
  },
}));

// orgAccess pulls in resolveActiveOrg, which imports the NON-/infra barrel; left real it would
// reach the actual mongoose models. Nothing in this route calls through it.
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));

import '../index';

// Valid 24-hex ObjectId strings (pass Types.ObjectId round-trip validation).
const ORG = '650000000000000000000abc';
const OWNER = '650000000000000000000111';
const STRANGER = '650000000000000000000333';

const org = { id: ORG, userId: OWNER };
const workspace = {
  id: 'ws_1',
  organizationId: ORG,
  slackTeamId: 'T1',
  slackTeamName: 'Acme',
  slackAppId: 'A1',
  slackBotUserId: 'U1',
  enabled: true,
  installedAt: new Date('2026-01-01'),
  installedBy: OWNER,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
};

function makeReq(user: { id: string; isAdmin: boolean }, orgId: string = ORG) {
  const { req, res } = createMocks({ method: 'GET' });
  (req as Record<string, unknown>).query = { id: orgId };
  (req as Record<string, unknown>).user = user;
  return { req, res };
}

const owner = { id: OWNER, isAdmin: false };
const stranger = { id: STRANGER, isAdmin: false };
const admin = { id: STRANGER, isAdmin: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgFindById.mockResolvedValue(org);
  mockFindByOrganizationId.mockResolvedValue(workspace);
  mockWorkspaceDelete.mockResolvedValue(undefined);
});

describe('GET /api/organizations/[id]/integrations/slack', () => {
  it('returns the workspace to the org owner', async () => {
    const { req, res } = makeReq(owner);

    await routeHandlers.GET(req, res);

    expect(mockOrgFindById).toHaveBeenCalledWith(ORG);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ id: 'ws_1', slackTeamId: 'T1', enabled: true });
  });

  it('returns the workspace to a platform admin', async () => {
    const { req, res } = makeReq(admin);

    await routeHandlers.GET(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('404s a caller who does not own the org, without reading the workspace', async () => {
    const { req, res } = makeReq(stranger);

    await expect(routeHandlers.GET(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      statusCode: HttpStatus.NotFound,
      message: 'Organization not found',
    });

    // The gate must precede the lookup, or a non-owner learns whether the org has Slack wired up.
    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
  });

  it('404s when the org does not exist, identically to a non-owner', async () => {
    mockOrgFindById.mockResolvedValue(null);
    const { req, res } = makeReq(stranger);

    await expect(routeHandlers.GET(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'Organization not found',
    });
  });

  // The documented behaviour delta of the gate swap: the deleted inline helper handed the raw id
  // to findById and answered 404; the shared helper validates first and answers 400.
  it('400s a malformed org id without touching the database', async () => {
    const { req, res } = makeReq(owner, 'not-an-object-id');

    await expect(routeHandlers.GET(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
      message: 'Invalid organization ID',
    });

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
  });

  it('404s the owner when no workspace is connected', async () => {
    mockFindByOrganizationId.mockResolvedValue(null);
    const { req, res } = makeReq(owner);

    await routeHandlers.GET(req, res);

    expect(res.statusCode).toBe(404);
    expect(res._getJSONData()).toEqual({ error: 'No Slack workspace connected' });
  });
});

describe('DELETE /api/organizations/[id]/integrations/slack', () => {
  it('disconnects the workspace for the org owner', async () => {
    const { req, res } = makeReq(owner);

    await routeHandlers.DELETE(req, res);

    // The id of the resolved workspace, not the org id: deleting by the wrong key would still
    // satisfy a bare "was it called" assertion.
    expect(mockWorkspaceDelete).toHaveBeenCalledWith('ws_1');
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toMatchObject({ success: true });
  });

  // The load-bearing one. DELETE is destructive and holds a freshly swapped gate; a dropped or
  // renamed gate call on this arm alone is invisible to tsc.
  it('404s a non-owner and deletes nothing', async () => {
    const { req, res } = makeReq(stranger);

    await expect(routeHandlers.DELETE(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      statusCode: HttpStatus.NotFound,
    });

    expect(mockFindByOrganizationId).not.toHaveBeenCalled();
    expect(mockWorkspaceDelete).not.toHaveBeenCalled();
  });

  it('400s a malformed org id and deletes nothing', async () => {
    const { req, res } = makeReq(owner, 'not-an-object-id');

    await expect(routeHandlers.DELETE(req, res)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: HttpStatus.BadRequest,
    });

    expect(mockWorkspaceDelete).not.toHaveBeenCalled();
  });

  it('404s the owner when no workspace is connected, and deletes nothing', async () => {
    mockFindByOrganizationId.mockResolvedValue(null);
    const { req, res } = makeReq(owner);

    await expect(routeHandlers.DELETE(req, res)).rejects.toMatchObject({
      constructor: NotFoundError,
      message: 'No Slack workspace connected',
    });

    expect(mockWorkspaceDelete).not.toHaveBeenCalled();
  });
});
