import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for PUT /api/projects/[id].
 * Pins that the URL id is authoritative over any body field, and that a missing
 * or array-valued id is rejected before the service is reached.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  UnprocessableEntityError: class UnprocessableEntityError extends Error {},
}));

const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'p1', name: 'updated' }));
vi.mock('@bike4mind/services', () => ({
  projectService: { update: (...a: unknown[]) => mockUpdate(...a), get: vi.fn() },
}));

vi.mock('@bike4mind/database', () => ({
  projectRepository: {},
  userRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/isDuplicateKeyError', () => ({ isDuplicateKeyError: () => false }));
vi.mock('@bike4mind/common', () => ({ ProjectEvents: { UPDATE_PROJECT: 'update_project' } }));

import '@pages/api/projects/[id]/index';
import { BadRequestError } from '@bike4mind/utils';

function put(query: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'PUT', query, body });
  (req as any).user = { id: 'u1' };
  (req as any).ability = {};
  return { req, res };
}

describe('PUT /api/projects/[id] - URL id wins', () => {
  beforeEach(() => mockUpdate.mockClear());

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
    expect(userId).toBe('u1');
    expect(params).toEqual({ id: 'p1', name: 'new name', description: 'desc' });
  });
});
