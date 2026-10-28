import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-layer coverage for /api/[type]/[id]/revokeSharing.
 *
 * The real protection against body-override attacks is that revokeBodySchema is a
 * plain z.object({ userId, projectId }) with no .passthrough(): Zod strips any id
 * or type field from req.body before the spread is evaluated. The 'URL params win'
 * tests document that intent and verify the URL values reach the service; the
 * BadRequestError tests are load-bearing (they fail without the explicit guard).
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

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {},
}));

const mockRevoke = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'doc1' }));
const mockCleanUp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockProjectTargets = vi.hoisted(() => vi.fn().mockResolvedValue([{ userId: 'planned', fileIds: ['f1'] }]));
vi.mock('@bike4mind/services', () => ({
  sharingService: { revoke: (...a: unknown[]) => mockRevoke(...a) },
}));
vi.mock('@server/sharing/revokedFileReferences', () => ({
  cleanUpRevokedFileReferences: (...a: unknown[]) => mockCleanUp(...a),
  projectRevokeCleanupTargets: (...a: unknown[]) => mockProjectTargets(...a),
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {},
  fabFileRepository: {},
  projectRepository: {},
  userRepository: {},
  withTransaction: (fn: any) => fn(),
}));

import '../revokeSharing';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

function request(query: Record<string, unknown>, body: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'DELETE', query, body });
  (req as any).user = { id: 'caller' };
  (req as any).logger = { warn: vi.fn() };
  return { req, res };
}

describe('/api/[type]/[id]/revokeSharing - URL params win', () => {
  beforeEach(() => mockRevoke.mockClear());

  it('takes the document id from the URL, not from any body field', async () => {
    const { req, res } = request({ type: 'sessions', id: 'url-doc-id' }, { userId: 'u2', id: 'body-doc-id' });
    await mockRefs.useHandler!(req, res);
    const [, params] = mockRevoke.mock.calls[0];
    expect(params.id).toBe('url-doc-id');
  });

  it('takes the document type from the URL, not from any body field', async () => {
    const { req, res } = request({ type: 'sessions', id: 'doc1' }, { userId: 'u2', type: 'files' });
    await mockRefs.useHandler!(req, res);
    const [, params] = mockRevoke.mock.calls[0];
    expect(params.type).toBe('sessions');
  });

  it('forwards userId from the body (it is the revocation target, not the caller)', async () => {
    const { req, res } = request({ type: 'sessions', id: 'doc1' }, { userId: 'target-user' });
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

describe('/api/[type]/[id]/revokeSharing - revoked file references', () => {
  beforeEach(() => {
    mockRevoke.mockClear();
    mockRevoke.mockResolvedValue({ id: 'doc1' });
    mockCleanUp.mockClear();
    mockProjectTargets.mockClear();
  });

  it.each([
    ['a direct file revoke', {}],
    ['a project-scoped file revoke', { projectId: 'p1' }],
  ])("cleans up the revoked user's reference after %s", async (_label, extra) => {
    const { req, res } = request({ type: 'files', id: 'file1' }, { userId: 'target-user', ...extra });
    await mockRefs.useHandler!(req, res);
    expect(mockCleanUp).toHaveBeenCalledWith([{ userId: 'target-user', fileIds: ['file1'] }], expect.anything());
    expect(mockRevoke.mock.invocationCallOrder[0]).toBeLessThan(mockCleanUp.mock.invocationCallOrder[0]);
  });

  it("checks the session's files after an unscoped session revoke", async () => {
    mockRevoke.mockResolvedValue({ id: 's1', knowledgeIds: ['f1', 'f2'] });
    const { req, res } = request({ type: 'sessions', id: 's1' }, { userId: 'target-user' });
    await mockRefs.useHandler!(req, res);
    expect(mockCleanUp).toHaveBeenCalledWith([{ userId: 'target-user', fileIds: ['f1', 'f2'] }], expect.anything());
  });

  it('checks nothing after a project-scoped session revoke, which leaves file grants alone', async () => {
    mockRevoke.mockResolvedValue({ id: 's1', knowledgeIds: ['f1'] });
    const { req, res } = request({ type: 'sessions', id: 's1' }, { userId: 'target-user', projectId: 'p1' });
    await mockRefs.useHandler!(req, res);
    expect(mockCleanUp).toHaveBeenCalledWith([], expect.anything());
  });

  it('plans a project revoke before the cascade prunes the file list, and cleans up after it', async () => {
    const { req, res } = request({ type: 'projects', id: 'p1' }, { userId: 'member-1' });
    await mockRefs.useHandler!(req, res);
    expect(mockProjectTargets).toHaveBeenCalledWith('p1', 'member-1', expect.anything());
    expect(mockProjectTargets.mock.invocationCallOrder[0]).toBeLessThan(mockRevoke.mock.invocationCallOrder[0]);
    expect(mockCleanUp).toHaveBeenCalledWith([{ userId: 'planned', fileIds: ['f1'] }], expect.anything());
  });

  it('does not clean up when the revoke fails', async () => {
    mockRevoke.mockRejectedValueOnce(new Error('denied'));
    const { req, res } = request({ type: 'files', id: 'file1' }, { userId: 'target-user' });
    await expect(mockRefs.useHandler!(req, res)).rejects.toThrow('denied');
    expect(mockCleanUp).not.toHaveBeenCalled();
  });
});
