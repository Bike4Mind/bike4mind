// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Logger } from '@bike4mind/observability';

type RouteFn = (req: unknown, res: unknown) => unknown;
type Handler = (req: unknown, res: unknown) => Promise<void>;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findById: vi.fn(),
  findBySlug: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  publish: vi.fn(),
  smtpSendEmail: vi.fn(),
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
// The real queuedMailer runs: the event bus is the seam, and the SMTP mailer must stay untouched.
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/index', () => ({ default: { sendEmail: h.smtpSendEmail } }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
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
  vi.stubEnv('B4M_SELF_HOST', 'false');
  vi.spyOn(Logger, 'error').mockImplementation(() => {});
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue(template);
  h.findBySlug.mockResolvedValue(null);
  h.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'tpl-2', ...input }));
  h.update.mockImplementation(async (input: Record<string, unknown>) => ({ ...template, ...input }));
  h.remove.mockResolvedValue(undefined);
  h.publish.mockResolvedValue({ FailedEntryCount: 0, Entries: [{ EventId: 'event-1' }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    expect(h.publish.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('publishes the test mail as an email.send event carrying the template text', async () => {
    h.findById.mockResolvedValue({ ...template, textContent: 'Hi in plain text' });

    await call(testHandler, 'POST', { email: 'qa@example.com' });

    expect(h.publish).toHaveBeenCalledExactlyOnceWith({
      to: 'qa@example.com',
      subject: '[TEST] Hello',
      body: '<p>Hi</p>',
      text: 'Hi in plain text',
    });
    expect(h.smtpSendEmail).not.toHaveBeenCalled();
  });

  it('leaves the text off the event when the template has none', async () => {
    await call(testHandler, 'POST', { email: 'qa@example.com' });

    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0][0]).not.toHaveProperty('text');
  });

  it('records nothing when the event cannot be queued', async () => {
    h.publish.mockRejectedValue(new Error('bus unreachable'));

    await expect(call(testHandler, 'POST', { email: 'qa@example.com' })).rejects.toThrow();

    expect(h.smtpSendEmail).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
