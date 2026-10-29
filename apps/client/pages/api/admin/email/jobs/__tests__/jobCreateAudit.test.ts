// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findTemplate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: RouteFn) => ((routes.GET = fn), chain),
        post: (fn: RouteFn) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  emailJobRepository: { create: h.create, listJobs: vi.fn() },
  emailTemplateRepository: { findById: h.findTemplate },
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../index';

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findTemplate.mockResolvedValue({ id: 'tpl-1', category: 'marketing' });
  h.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'job-9', ...input }));
});

describe('POST /api/admin/email/jobs', () => {
  it('records email.job.created after the job is created', async () => {
    const { req, res } = createMocks({ method: 'POST', body: { name: 'Launch', templateId: 'tpl-1', subject: 'Hi' } });
    (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.created',
      target: { kind: 'settings', id: 'job-9', displayName: 'Launch' },
      details: { templateId: 'tpl-1' },
    });
    expect(h.audit.mock.calls[0][1].details).not.toHaveProperty('subject');
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
