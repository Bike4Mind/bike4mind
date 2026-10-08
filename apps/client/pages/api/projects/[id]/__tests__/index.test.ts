import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for PUT /api/projects/[id].
 *
 * The real protection against body-override attacks is that updateProjectBodySchema
 * is a plain z.object() with no .passthrough(): Zod strips any id field from
 * req.body before the spread is evaluated. The 'URL id wins' test documents that
 * intent; the BadRequestError tests are load-bearing.
 */

type RouteHandler = (req: unknown, res: unknown) => unknown;

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | RouteHandler,
  putHandler: null as null | RouteHandler,
  deleteHandler: null as null | RouteHandler,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: RouteHandler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: (fn: RouteHandler) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: (fn: RouteHandler) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  UnprocessableEntityError: class UnprocessableEntityError extends Error {},
}));

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'p1', name: 'updated' }));
const mockGet = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'p1', name: 'project' }));
const mockDeleteProject = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/services', () => ({
  projectService: {
    update: (...a: unknown[]) => mockUpdate(...a),
    get: (...a: unknown[]) => mockGet(...a),
    deleteProject: (...a: unknown[]) => mockDeleteProject(...a),
  },
}));

vi.mock('@bike4mind/database', () => ({
  projectRepository: {},
  userRepository: {},
  sessionRepository: {},
  fabFileRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/isDuplicateKeyError', () => ({ isDuplicateKeyError: () => false }));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/common')>()),
  ProjectEvents: { UPDATE_PROJECT: 'update_project', DELETE_PROJECT: 'delete_project' },
}));
// Spies that call through, so the scope assert both records its call and still enforces for real.
vi.mock('@server/projects/projectScopes', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/projects/projectScopes')>();
  return {
    ...actual,
    assertProjectsReadScope: vi.fn(actual.assertProjectsReadScope),
    assertProjectsWriteScope: vi.fn(actual.assertProjectsWriteScope),
  };
});

import '@pages/api/projects/[id]/index';
import { ApiKeyScope } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { ForbiddenError } from '@server/utils/errors';
import { assertProjectsReadScope, assertProjectsWriteScope } from '@server/projects/projectScopes';

function request(method: 'GET' | 'DELETE', query: Record<string, unknown>) {
  const { req, res } = createMocks({ method, query });
  Object.assign(req, { user: { id: 'u1' }, ability: {} });
  return { req, res };
}

function put(query: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'PUT', query, body });
  (req as any).user = { id: 'u1' };
  (req as any).ability = {};
  return { req, res };
}

describe('PUT /api/projects/[id] - URL id wins', () => {
  beforeEach(() => vi.clearAllMocks());

  it('takes the project id from the URL, not from any body field', async () => {
    const { req, res } = put({ id: 'url-project-id' }, { id: 'body-project-id', name: 'renamed' });
    await mockRefs.putHandler!(req, res);
    const [, params] = mockUpdate.mock.calls[0];
    expect(params.id).toBe('url-project-id');
    expect(params.name).toBe('renamed');
  });

  it('rejects a missing id with BadRequestError before reaching the service', async () => {
    const { req, res } = put({}, { name: 'renamed' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('rejects an array-valued id with BadRequestError before reaching the service', async () => {
    const { req, res } = put({ id: ['a', 'b'] }, { name: 'renamed' });
    await expect(mockRefs.putHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('passes a valid update through to the service with only validated body fields', async () => {
    const { req, res } = put({ id: 'p1' }, { name: 'new name', description: 'desc' });
    await mockRefs.putHandler!(req, res);
    const [userId, params] = mockUpdate.mock.calls[0];
    expect(assertProjectsWriteScope).toHaveBeenCalledWith(req);
    expect(userId).toBe('u1');
    expect(params).toEqual({ id: 'p1', name: 'new name', description: 'desc' });
  });
});

describe('GET and DELETE /api/projects/[id] scope asserts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET asserts projects:read with the request', async () => {
    const { req, res } = request('GET', { id: 'p1' });
    await mockRefs.getHandler!(req, res);
    expect(assertProjectsReadScope).toHaveBeenCalledWith(req);
  });

  it('DELETE asserts projects:write with the request', async () => {
    const { req, res } = request('DELETE', { id: 'p1' });
    await mockRefs.deleteHandler!(req, res);
    expect(assertProjectsWriteScope).toHaveBeenCalledWith(req);
  });
});

describe('API-key scope enforcement at runtime', () => {
  const originalStaging = process.env.API_KEY_SCOPE_STAGING;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.API_KEY_SCOPE_STAGING;
  });

  afterEach(() => {
    if (originalStaging === undefined) delete process.env.API_KEY_SCOPE_STAGING;
    else process.env.API_KEY_SCOPE_STAGING = originalStaging;
  });

  it('refuses a PUT from a key holding only projects:read, without updating', async () => {
    const { req, res } = put({ id: 'p1' }, { name: 'renamed' });
    Object.assign(req, { apiKeyInfo: { scopes: [ApiKeyScope.READ_PROJECTS] } });
    await expect(mockRefs.putHandler!(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
