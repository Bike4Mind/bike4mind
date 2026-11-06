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
  list: vi.fn(),
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
vi.mock('@server/dataSubject/adminDataExports', () => ({
  findDataExportTarget: h.findTarget,
  listAdminDataExports: h.list,
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

import { ApiKeyScope } from '@bike4mind/common';
import '../index';

const ADMIN_ID = 'admin-1';
const USER_ID = '665f1c2e8b3a4d0012345678';
const TARGET = { kind: 'user', id: USER_ID, displayName: 'ada@example.com' };

function mocks(method: 'GET' | 'POST', body?: unknown) {
  const { req, res } = createMocks({ method, query: { userId: USER_ID }, body });
  Object.assign(req, { user: { id: ADMIN_ID, isAdmin: true } });
  return { req, res };
}

beforeEach(() => {
  h.calls = [];
  h.requireStepUp.mockReset().mockImplementation(async () => void h.calls.push('stepUp'));
  h.findTarget.mockReset().mockResolvedValue({ user: { id: USER_ID }, auditTarget: TARGET });
  h.record.mockReset().mockImplementation(async () => void h.calls.push('audit'));
  h.send.mockReset().mockImplementation(async () => void h.calls.push('enqueue'));
  h.list.mockReset().mockResolvedValue([]);
});

describe('admin data subject export requests', () => {
  it('needs users:export for both methods, admin-scoped keys and CSRF', () => {
    expect(h.adminApiOptions).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: 'users:export', POST: 'users:export' },
    });
    expect(h.uses).toEqual(['csrfProtection']);
  });

  it('audits the request before queuing it on the export worker with the requesting admin', async () => {
    const { req, res } = mocks('POST', { reason: 'Art. 15 request by email' });

    await h.post!(req, res);

    expect(res._getStatusCode()).toBe(202);
    const { exportJobId } = res._getJSONData();
    expect(h.calls).toEqual(['stepUp', 'audit', 'enqueue']);
    expect(h.findTarget).toHaveBeenCalledWith(req.user, USER_ID);
    expect(h.record).toHaveBeenCalledWith(req, {
      action: 'user.data_export.requested',
      target: TARGET,
      summary: 'requested a data subject export',
      reason: 'Art. 15 request by email',
      details: { exportJobId },
    });
    expect(h.send).toHaveBeenCalledWith('http://queue/accountDataExportQueue', {
      exportJobId,
      userId: USER_ID,
      requestedBy: ADMIN_ID,
    });
  });

  it('queues nothing without a reason', async () => {
    const { req, res } = mocks('POST', {});

    await expect(h.post!(req, res)).rejects.toThrow('A reason is required');
    expect(h.record).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('queues nothing when the request cannot be audited', async () => {
    h.record.mockRejectedValue(new Error('audit write failed'));
    const { req, res } = mocks('POST', { reason: 'Art. 20 request' });

    await expect(h.post!(req, res)).rejects.toThrow('audit write failed');
    expect(h.send).not.toHaveBeenCalled();
  });

  it('queues nothing without a fresh step-up', async () => {
    h.requireStepUp.mockRejectedValue(new Error('step_up_required'));
    const { req, res } = mocks('POST', { reason: 'Art. 15 request' });

    await expect(h.post!(req, res)).rejects.toThrow('step_up_required');
    expect(h.record).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('lists the recent exports uncached', async () => {
    const listed = [{ exportJobId: 'job', status: { state: 'building' } }];
    h.list.mockResolvedValue(listed);
    const { req, res } = mocks('GET');

    await h.get!(req, res);

    expect(h.list).toHaveBeenCalledWith(USER_ID);
    expect(res._getJSONData()).toEqual({ exports: listed });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });
});
