import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for /api/[type]/[id]/revokeSharing.
 * Pins that the URL id and type are authoritative (not overridable by the body),
 * and that a missing or array-valued id is rejected before the service is called.
 */

const mockRefs = vi.hoisted(() => ({
  useHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    use: (fn: any) => {
      mockRefs.useHandler = fn;
      return { use: () => ({}) };
    },
  }),
}));

vi.mock('@server/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

const mockRevoke = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'doc1' }));
vi.mock('@bike4mind/services', () => ({
  sharingService: { revoke: (...a: unknown[]) => mockRevoke(...a) },
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
}));

import '../revokeSharing';
import { BadRequestError } from '@server/utils/errors';

function request(query: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'DELETE', query, body });
  (req as any).user = { id: 'caller' };
  return { req, res };
}

describe('/api/[type]/[id]/revokeSharing - URL params win', () => {
  beforeEach(() => mockRevoke.mockClear());

  it('takes the document id from the URL, not from any body field', async () => {
    const { req, res } = request(
      { type: 'sessions', id: 'url-doc-id' },
      { userId: 'u2', id: 'body-doc-id' }
    );
    await mockRefs.useHandler!(req, res);
    const [, params] = mockRevoke.mock.calls[0];
    expect(params.id).toBe('url-doc-id');
  });

  it('takes the document type from the URL, not from any body field', async () => {
    const { req, res } = request(
      { type: 'sessions', id: 'doc1' },
      { userId: 'u2', type: 'files' }
    );
    await mockRefs.useHandler!(req, res);
    const [, params] = mockRevoke.mock.calls[0];
    expect(params.type).toBe('sessions');
  });

  it('forwards userId from the body (it is the revocation target, not the caller)', async () => {
    const { req, res } = request(
      { type: 'sessions', id: 'doc1' },
      { userId: 'target-user' }
    );
    await mockRefs.useHandler!(req, res);
    const [callerId, params] = mockRevoke.mock.calls[0];
    expect(callerId).toBe('caller');
    expect(params.userId).toBe('target-user');
  });

  it('rejects a missing id with BadRequestError before reaching the service', async () => {
    const { req, res } = request({ type: 'sessions' }, { userId: 'u2' });
    await expect(mockRefs.useHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('rejects an array-valued id with BadRequestError before reaching the service', async () => {
    const { req, res } = request({ type: 'sessions', id: ['a', 'b'] }, { userId: 'u2' });
    await expect(mockRefs.useHandler!(req, res)).rejects.toBeInstanceOf(BadRequestError);
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
