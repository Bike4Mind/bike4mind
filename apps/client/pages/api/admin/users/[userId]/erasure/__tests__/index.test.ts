import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  get: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  post: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  uses: [] as unknown[],
  adminApiOptions: undefined as unknown,
  calls: [] as string[],
  send: vi.fn(),
  record: vi.fn(),
  requireStepUp: vi.fn(),
  findTarget: vi.fn(),
  readState: vi.fn(),
  requestErasure: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.adminApiOptions = options;
    const chain = {
      use: (middleware: unknown) => {
        h.uses.push(middleware);
        return chain;
      },
      get: (fn: typeof h.get) => {
        h.get = fn;
        return chain;
      },
      post: (fn: typeof h.post) => {
        h.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: () => 'csrfProtection' }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: h.requireStepUp }));
vi.mock('@server/dataSubject/adminErasure', () => ({
  findErasureTarget: h.findTarget,
  readAdminErasureState: h.readState,
}));
vi.mock('@server/users/accountDeletion', () => ({
  requestAdminErasure: h.requestErasure,
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: h.record,
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new Error('A reason is required');
    return value;
  },
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.send }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (name: string) => `http://queue/${name}`,
}));

import { ACCOUNT_DELETION_ORG_OWNER_CODE, ApiKeyScope, ConflictError, ForbiddenError } from '@bike4mind/common';
import '../index';

const ADMIN_ID = 'admin-1';
const USER_ID = '665f1c2e8b3a4d0012345678';
const TARGET = { kind: 'user', id: USER_ID, displayName: USER_ID };

function mocks(method: 'GET' | 'POST', body?: unknown) {
  const { req, res } = createMocks({ method, query: { userId: USER_ID }, body });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true }, logger: { error: vi.fn() } });
  return { req, res };
}

beforeEach(() => {
  h.calls = [];
  h.requireStepUp.mockReset().mockImplementation(async () => void h.calls.push('stepUp'));
  h.findTarget.mockReset().mockResolvedValue({ user: { id: USER_ID }, auditTarget: TARGET });
  h.readState.mockReset().mockResolvedValue({ state: 'none', ownedOrganizations: [] });
  h.record.mockReset().mockImplementation(async () => void h.calls.push('audit'));
  h.requestErasure.mockReset().mockImplementation(async () => void h.calls.push('request'));
  h.send.mockReset().mockImplementation(async () => void h.calls.push('enqueue'));
});

describe('admin data subject erasure request', () => {
  it('needs users:delete for both methods, admin-scoped keys, jwtOnly and CSRF', () => {
    expect(h.adminApiOptions).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'users:delete', POST: 'users:delete' },
    });
    expect(h.uses).toEqual(['csrfProtection']);
  });

  it('GET returns the erasure state uncached', async () => {
    h.readState.mockResolvedValue({ state: 'requested' });
    const { req, res } = mocks('GET');

    await h.get!(req, res);

    expect(h.findTarget).toHaveBeenCalledWith(req.user, USER_ID);
    expect(h.readState).toHaveBeenCalledWith(USER_ID);
    expect(res._getJSONData()).toEqual({ state: 'requested' });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });

  it('audits, then marks the account, then enqueues, and answers 202 queued', async () => {
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await h.post!(req, res);

    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ queued: true });
    expect(h.calls).toEqual(['stepUp', 'audit', 'request', 'enqueue']);
    expect(h.record).toHaveBeenCalledWith(req, {
      action: 'user.erasure.requested',
      target: TARGET,
      summary: 'requested a data subject erasure',
      reason: 'Art. 17 request',
    });
    expect(h.requestErasure).toHaveBeenCalledWith(req, USER_ID);
    expect(h.send).toHaveBeenCalledWith('http://queue/accountErasureQueue', { userId: USER_ID });
    const [audit, request, enqueue] = [h.record, h.requestErasure, h.send].map(m => m.mock.invocationCallOrder[0]);
    expect(audit).toBeLessThan(request);
    expect(request).toBeLessThan(enqueue);
  });

  it('refuses without a fresh step-up before touching anything', async () => {
    h.requireStepUp.mockRejectedValue(new Error('step_up_required'));
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await expect(h.post!(req, res)).rejects.toThrow('step_up_required');
    expect(h.findTarget).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('refuses without a reason', async () => {
    const { req, res } = mocks('POST', {});

    await expect(h.post!(req, res)).rejects.toThrow('A reason is required');
    expect(h.findTarget).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.requestErasure).not.toHaveBeenCalled();
  });

  it('refuses to erase the calling admin', async () => {
    h.findTarget.mockResolvedValue({ user: { id: ADMIN_ID }, auditTarget: TARGET });
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await expect(h.post!(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.requestErasure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(['selfDeletionPending', 'requested'])('refuses with 409 and no audit when the state is %s', async state => {
    h.readState.mockResolvedValue({ state });
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await expect(h.post!(req, res)).rejects.toBeInstanceOf(ConflictError);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.requestErasure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('refuses with the owner code and no audit when the user owns an organization', async () => {
    h.readState.mockResolvedValue({ state: 'none', ownedOrganizations: [{ id: 'org-1', name: 'Acme' }] });
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    const error = await h.post!(req, res).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect(JSON.stringify(error)).toContain(ACCOUNT_DELETION_ORG_OWNER_CODE);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.requestErasure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('marks and enqueues nothing when the request cannot be audited', async () => {
    h.record.mockRejectedValue(new Error('audit write failed'));
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await expect(h.post!(req, res)).rejects.toThrow('audit write failed');
    expect(h.requestErasure).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('still answers 202 with queued false and logs when the queue is unreachable', async () => {
    h.send.mockRejectedValue(new Error('sqs down'));
    const { req, res } = mocks('POST', { reason: 'Art. 17 request' });

    await h.post!(req, res);

    expect(res._getStatusCode()).toBe(202);
    expect(res._getJSONData()).toEqual({ queued: false });
    expect((req as unknown as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error).toHaveBeenCalledWith(
      expect.stringContaining('sqs down')
    );
  });
});
