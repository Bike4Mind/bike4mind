import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@server/utils/errors';

/**
 * GET /api/organizations/users names individual members and their login/export/download
 * counts, so it is an owner/manager view - it now gates on verifyOrgAccess (which answers
 * NotFoundError identically for a missing org and one the caller may not administer) before
 * ever reading the organization.
 *
 * The route's handler body is wrapped in a single try/catch that used to turn EVERY error into a
 * 500, which would have reported these refusals as server faults. It now re-throws anything
 * carrying a numeric statusCode, so a gate rejection propagates with its own status and only
 * genuinely unexpected failures still collapse to a 500.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const verifyOrgAccess = vi.hoisted(() => vi.fn());
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess }));

const findById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  Organization: { findById },
  User: { aggregate: vi.fn() },
  UserActivityCounter: { find: vi.fn(async () => []) },
  convertIds: (ids: unknown) => ids,
  convertPipelineForDocumentDB: (pipeline: unknown) => pipeline,
  mongoose: { Types: { ObjectId: class {} } },
}));

import '@pages/api/organizations/users';

type ChainableQuery<T> = Promise<T> & { select: () => ChainableQuery<T> };

function chainable<T>(result: T): ChainableQuery<T> {
  const query = Promise.resolve(result) as ChainableQuery<T>;
  query.select = () => query;
  return query;
}

function mocks(user: unknown, query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({
    method: 'GET',
    query: { pageSize: '10', pageNumber: '1', ...query },
  });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/organizations/users - verifyOrgAccess gate', () => {
  beforeEach(() => {
    verifyOrgAccess.mockReset();
    findById.mockReset();
  });

  it('calls verifyOrgAccess with the resolved org id before Organization.findById runs', async () => {
    const order: string[] = [];
    verifyOrgAccess.mockImplementation(async (_user: unknown, orgId: string) => {
      order.push(`verifyOrgAccess:${orgId}`);
      return { id: orgId };
    });
    findById.mockImplementation(() => {
      order.push('findById');
      return chainable(null);
    });

    const { req, res } = mocks({ id: 'u1', isAdmin: false, organizationId: 'org1' });
    // findById resolves null here, so the route's own not-found throw ends the run - the ordering
    // is what this pins, and stubbing the whole aggregation pipeline to reach a 200 would add a
    // large fixture that proves nothing extra about the gate.
    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 404 });

    expect(order).toEqual(['verifyOrgAccess:org1', 'findById']);
    expect(verifyOrgAccess).toHaveBeenCalledWith(req.user, 'org1');
  });

  it('never reaches Organization.findById when verifyOrgAccess rejects', async () => {
    verifyOrgAccess.mockRejectedValueOnce(new NotFoundError('Organization not found'));

    const { req, res } = mocks({ id: 'u1', isAdmin: false, organizationId: 'org1' });
    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({ statusCode: 404 });

    expect(findById).not.toHaveBeenCalled();
    expect(res._getStatusCode()).not.toBe(500);
  });

  it('produces a NotFoundError, not a TypeError, when the caller has no organization', async () => {
    // No organizationId and no admin-supplied filters.orgId: orgId is undefined, so this exercises
    // the `if (!orgId)` guard rather than the `orgId.toString()` call a couple of lines below it.
    // A TypeError has no statusCode, so it would be swallowed into a 500 instead of propagating -
    // which is exactly what distinguishes the two here.
    const { req, res } = mocks({ id: 'u1', isAdmin: false });
    await expect(mockRefs.getHandler!(req, res)).rejects.toMatchObject({
      statusCode: 404,
      name: 'NotFoundError',
    });

    expect(verifyOrgAccess).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  // The other half of the catch-all change: an UNEXPECTED failure must still collapse to a 500
  // rather than escaping, or this fix would have turned every incidental throw into an unhandled
  // rejection.
  it('still answers 500 for an unexpected error carrying no statusCode', async () => {
    verifyOrgAccess.mockRejectedValueOnce(new TypeError('boom'));

    const { req, res } = mocks({ id: 'u1', isAdmin: false, organizationId: 'org1' });
    await expect(mockRefs.getHandler!(req, res)).resolves.toBeUndefined();

    expect(res._getStatusCode()).toBe(500);
  });
});
