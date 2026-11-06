import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  post: undefined as undefined | ((req: unknown, res: unknown) => Promise<unknown>),
  uses: [] as unknown[],
  adminApiOptions: undefined as unknown,
  record: vi.fn(),
  findTarget: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: unknown) => {
    h.adminApiOptions = options;
    const chain = {
      use: (middleware: unknown) => {
        h.uses.push(middleware);
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
vi.mock('@server/dataSubject/adminErasure', () => ({
  findErasureTarget: h.findTarget,
  previewAdminErasure: h.preview,
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: h.record,
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string' || !value) throw new Error('A reason is required');
    return value;
  },
}));

import { ApiKeyScope } from '@bike4mind/common';
import '../preview';

const USER_ID = '665f1c2e8b3a4d0012345678';
const TARGET = { kind: 'user', id: USER_ID, displayName: 'ada@example.com' };
const USER = { id: USER_ID };

function mocks(body?: unknown) {
  const { req, res } = createMocks({ method: 'POST', query: { userId: USER_ID }, body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  return { req, res };
}

beforeEach(() => {
  h.record.mockReset().mockResolvedValue(undefined);
  h.findTarget.mockReset().mockResolvedValue({ user: USER, auditTarget: TARGET });
  h.preview.mockReset().mockResolvedValue({ collections: [] });
});

describe('admin data subject erasure preview', () => {
  it('needs users:delete, admin-scoped keys, jwtOnly and CSRF', () => {
    expect(h.adminApiOptions).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { POST: 'users:delete' },
    });
    expect(h.uses).toEqual(['csrfProtection']);
  });

  it('audits the preview before the walk and returns it uncached', async () => {
    const preview = { collections: [{ name: 'quests', deleted: 3 }] };
    h.preview.mockResolvedValue(preview);
    const { req, res } = mocks({ reason: 'Art. 17 request' });

    await h.post!(req, res);

    expect(h.record).toHaveBeenCalledWith(req, {
      action: 'user.erasure.previewed',
      target: TARGET,
      summary: 'previewed a data subject erasure',
      reason: 'Art. 17 request',
    });
    expect(h.preview).toHaveBeenCalledWith(USER);
    expect(h.record.mock.invocationCallOrder[0]).toBeLessThan(h.preview.mock.invocationCallOrder[0]);
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual(preview);
    expect(res.getHeader('Cache-Control')).toBe('no-store');
  });

  it('does not walk when the preview cannot be audited', async () => {
    h.record.mockRejectedValue(new Error('audit write failed'));
    const { req, res } = mocks({ reason: 'Art. 17 request' });

    await expect(h.post!(req, res)).rejects.toThrow('audit write failed');
    expect(h.preview).not.toHaveBeenCalled();
  });

  it('refuses without a reason', async () => {
    const { req, res } = mocks({});

    await expect(h.post!(req, res)).rejects.toThrow('A reason is required');
    expect(h.record).not.toHaveBeenCalled();
    expect(h.preview).not.toHaveBeenCalled();
  });
});
