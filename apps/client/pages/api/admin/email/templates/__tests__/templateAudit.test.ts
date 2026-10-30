// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;
type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: RouteFn) => ((routes.GET = fn), chain),
        post: (fn: RouteFn) => ((routes.POST = fn), chain),
        put: (fn: RouteFn) => ((routes.PUT = fn), chain),
        delete: (fn: RouteFn) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  emailTemplateRepository: {
    findById: h.findById,
    findBySlug: h.findBySlug,
    create: h.create,
    update: h.update,
    delete: h.remove,
    listTemplates: vi.fn(),
  },
}));
vi.mock('@server/utils/mailer', () => ({ default: { sendEmail: h.sendEmail } }));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: h.audit,
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

import indexHandler from '../index';
import idHandler from '../[id]';
import cloneHandler from '../[id]/clone';
import testHandler from '../[id]/test';

const template = {
  id: 'tpl-1',
  name: 'Welcome',
  slug: 'welcome',
  subject: 'Hello',
  htmlContent: '<p>Hi</p>',
  category: 'marketing',
  variables: [],
  isActive: true,
};

const call = async (handler: unknown, method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method, query: { id: 'tpl-1' }, body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as Handler)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue(template);
  h.findBySlug.mockResolvedValue(null);
  h.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'tpl-2', ...input }));
  h.update.mockImplementation(async (input: Record<string, unknown>) => ({ ...template, ...input }));
  h.remove.mockResolvedValue(undefined);
  h.sendEmail.mockResolvedValue(true);
});

describe('POST /api/admin/email/templates', () => {
  it('records email.template.created after the create', async () => {
    const { res } = await call(indexHandler, 'POST', {
      name: 'Welcome',
      slug: 'welcome-2',
      subject: 'Hello',
      htmlContent: '<p>Hi</p>',
      category: 'marketing',
    });

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.template.created',
      target: { kind: 'settings', id: 'tpl-2', displayName: 'Welcome' },
    });
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('PUT /api/admin/email/templates/:id', () => {
  it('records email.template.updated with field names and no content', async () => {
    const { res } = await call(idHandler, 'PUT', { name: 'Renamed', htmlContent: '<p>secret body</p>' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({
      action: 'email.template.updated',
      target: { kind: 'settings', id: 'tpl-1' },
      details: { updatedFields: ['name', 'htmlContent'] },
    });
    expect(JSON.stringify(input)).not.toContain('secret body');
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('DELETE /api/admin/email/templates/:id', () => {
  it('records email.template.deleted after the delete', async () => {
    const { res } = await call(idHandler, 'DELETE');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.template.deleted',
      target: { kind: 'settings', id: 'tpl-1', displayName: 'Welcome' },
    });
    expect(h.remove.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('POST /api/admin/email/templates/:id/clone', () => {
  it('records email.template.cloned for the new template', async () => {
    const { res } = await call(cloneHandler, 'POST');

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.template.cloned',
      target: { kind: 'settings', id: 'tpl-2' },
      details: { sourceTemplateId: 'tpl-1' },
    });
  });
});

describe('POST /api/admin/email/templates/:id/test', () => {
  it('records email.template.test_sent after the mail is sent, with a count not the address', async () => {
    const { res } = await call(testHandler, 'POST', { email: 'qa@example.com' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({
      action: 'email.template.test_sent',
      target: { kind: 'settings', id: 'tpl-1', displayName: 'Welcome' },
      details: { recipientCount: 1 },
    });
    expect(JSON.stringify(input)).not.toContain('qa@example.com');
    expect(h.sendEmail.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('records nothing when the mailer fails', async () => {
    h.sendEmail.mockResolvedValue(false);

    await expect(call(testHandler, 'POST', { email: 'qa@example.com' })).rejects.toThrow();

    expect(h.audit).not.toHaveBeenCalled();
  });
});
