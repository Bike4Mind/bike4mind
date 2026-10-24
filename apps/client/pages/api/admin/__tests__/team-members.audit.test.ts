// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  remove: vi.fn(),
  findByPhone: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const on = (method: string) => (fn: (req: unknown, res: unknown) => unknown) => ((routes[method] = fn), chain);
    const chain: Record<string, unknown> = Object.assign(
      (req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res),
      {
        get: on('GET'),
        post: on('POST'),
        put: on('PUT'),
        delete: on('DELETE'),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  internalTeamMemberRepository: {
    create: h.create,
    update: h.update,
    findById: h.findById,
    delete: h.remove,
    findByPhone: h.findByPhone,
  },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../team-members';

const run = async (method: 'POST' | 'PUT' | 'DELETE', options: { body?: object; query?: Record<string, string> }) => {
  const { req, res } = createMocks({ method, body: options.body, query: options.query });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as (rq: unknown, rs: unknown) => Promise<void>)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
});

describe('/api/admin/team-members admin audit', () => {
  it('POST records team_member.created without the phone number', async () => {
    h.findByPhone.mockResolvedValue(null);
    h.create.mockResolvedValue({ id: 'tm-1', name: 'Ada', phone: '+15550100', role: 'Engineer', isActive: true });
    const { req, res } = await run('POST', { body: { name: 'Ada', phone: '+15550100', role: 'Engineer' } });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.team_member.created',
      target: { kind: 'settings', id: 'tm-1', displayName: 'Ada' },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('+15550100');
  });

  it('PUT records team_member.updated with the changed field names only', async () => {
    h.update.mockResolvedValue({ id: 'tm-1', name: 'Ada', phone: '+15550100' });
    await run('PUT', { body: { id: 'tm-1', phone: '+15550199' } });

    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.team_member.updated',
      target: { kind: 'settings', id: 'tm-1', displayName: 'Ada' },
      details: { fields: ['phone'] },
    });
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain('+15550199');
  });

  it('DELETE records team_member.deleted after the delete', async () => {
    h.findById.mockResolvedValue({ id: 'tm-1', name: 'Ada', role: 'Engineer' });
    h.remove.mockResolvedValue(undefined);
    const { res } = await run('DELETE', { query: { id: 'tm-1' } });

    expect(res._getStatusCode()).toBe(200);
    expect(h.remove).toHaveBeenCalledWith('tm-1');
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'settings.team_member.deleted',
      target: { kind: 'settings', id: 'tm-1', displayName: 'Ada' },
    });
  });

  it('DELETE records nothing when the member does not exist', async () => {
    h.findById.mockResolvedValue(null);
    await run('DELETE', { query: { id: 'gone' } });

    expect(h.audit).not.toHaveBeenCalled();
  });
});
