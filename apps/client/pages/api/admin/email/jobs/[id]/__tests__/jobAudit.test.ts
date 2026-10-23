// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  claimForSending: vi.fn(),
  cancelPendingAttempts: vi.fn(),
  sendToQueue: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        get: (fn: RouteFn) => ((routes.GET = fn), chain),
        post: (fn: RouteFn) => ((routes.POST = fn), chain),
        put: (fn: RouteFn) => ((routes.PUT = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  emailJobRepository: {
    findById: h.findById,
    update: h.update,
    create: h.create,
    claimForSending: h.claimForSending,
  },
  emailSendAttemptRepository: { cancelPendingAttempts: h.cancelPendingAttempts },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (name: string) => `queue://${name}`,
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import startHandler from '../start';
import sendHandler from '../send';
import cloneHandler from '../clone';
import scheduleHandler from '../schedule';
import cancelHandler from '../cancel';
import updateHandler from '../index';

type Handler = (req: unknown, res: unknown) => Promise<void>;

const call = async (handler: unknown, method: 'POST' | 'PUT', body: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method, query: { id: 'job-1' }, body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true, name: 'Admin', email: 'a@example.com' };
  await (handler as Handler)(req, res);
  return { req, res };
};

const draftJob = {
  id: 'job-1',
  name: 'Launch',
  templateId: 'tpl-1',
  subject: 'Hi',
  isTestMode: false,
  status: 'draft',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findById.mockResolvedValue(draftJob);
  h.update.mockImplementation(async (input: Record<string, unknown>) => ({ ...draftJob, ...input }));
  h.create.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'job-2', ...input }));
  h.claimForSending.mockResolvedValue(draftJob);
  h.cancelPendingAttempts.mockResolvedValue(3);
  h.sendToQueue.mockResolvedValue(undefined);
});

describe('POST /api/admin/email/jobs/:id/start', () => {
  it('writes the strict audit after the status change and before the enqueue', async () => {
    const { req, res } = await call(startHandler, 'POST');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.started',
      target: { kind: 'settings', id: 'job-1', displayName: 'Launch' },
    });
    expect(h.audit.mock.calls[0][1].details).not.toHaveProperty('subject');
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.sendToQueue.mock.invocationCallOrder[0]);
  });

  it('records a test-mode job at notice severity under its own action', async () => {
    h.findById.mockResolvedValue({ ...draftJob, isTestMode: true });

    await call(startHandler, 'POST');

    expect(h.audit.mock.calls[0][1]).toMatchObject({ action: 'email.job.test_started' });
  });

  it('sends nothing when the audit write fails', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(call(startHandler, 'POST')).rejects.toThrow('audit down');

    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/email/jobs/:id/send', () => {
  it('writes the strict audit after the claim and before the enqueue', async () => {
    const { req, res } = await call(sendHandler, 'POST', { userIds: ['u1', 'u2'] });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.sent',
      target: { kind: 'settings', id: 'job-1', displayName: 'Launch' },
      details: { userIdCount: 2, testMode: false },
    });
    expect(h.audit.mock.calls[0][1].details).not.toHaveProperty('subject');
    expect(h.claimForSending.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.sendToQueue.mock.invocationCallOrder[0]);
  });

  it('records a test-mode send under its own action', async () => {
    await call(sendHandler, 'POST', { testMode: true, testRecipients: ['t@example.com'] });

    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.test_sent',
      details: { testMode: true, testRecipientCount: 1 },
    });
  });

  it('sends nothing when the audit write fails', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    await expect(call(sendHandler, 'POST')).rejects.toThrow('audit down');

    expect(h.sendToQueue).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/email/jobs/:id/clone', () => {
  it('records email.job.cloned for the new job', async () => {
    const { res } = await call(cloneHandler, 'POST');

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.cloned',
      target: { kind: 'settings', id: 'job-2' },
      details: { sourceJobId: 'job-1' },
    });
    expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('POST /api/admin/email/jobs/:id/schedule', () => {
  it('records email.job.scheduled after the status update', async () => {
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();

    const { res } = await call(scheduleHandler, 'POST', { scheduledAt });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.scheduled',
      target: { kind: 'settings', id: 'job-1', displayName: 'Launch' },
      details: { scheduledAt },
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('POST /api/admin/email/jobs/:id/cancel', () => {
  it('records email.job.cancelled with the cancelled count', async () => {
    h.findById.mockResolvedValue({ ...draftJob, status: 'queued', cancelledCount: 0 });

    const { res } = await call(cancelHandler, 'POST');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.cancelled',
      target: { kind: 'settings', id: 'job-1', displayName: 'Launch' },
      details: { cancelledCount: 3, wholeJob: true },
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});

describe('PUT /api/admin/email/jobs/:id', () => {
  it('records email.job.updated with the changed field names only', async () => {
    const { res } = await call(updateHandler, 'PUT', { name: 'Renamed', subject: 'New subject' });

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.updated',
      target: { kind: 'settings', id: 'job-1' },
      details: { updatedFields: ['name', 'subject'] },
    });
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });
});
