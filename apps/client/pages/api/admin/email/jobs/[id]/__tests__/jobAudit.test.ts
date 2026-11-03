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
  claimForStart: vi.fn(),
  cancelPendingAttempts: vi.fn(),
  sendToQueue: vi.fn(),
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
    claimForStart: h.claimForStart,
  },
  emailSendAttemptRepository: { cancelPendingAttempts: h.cancelPendingAttempts },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.sendToQueue }));
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({
  getSourceQueueUrl: (name: string) => `queue://${name}`,
}));
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: h.audit,
  definedKeys: (data: Record<string, unknown>) => Object.keys(data).filter(key => data[key] !== undefined),
}));

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
  h.claimForStart.mockResolvedValue(draftJob);
  h.cancelPendingAttempts.mockResolvedValue(3);
  h.sendToQueue.mockResolvedValue(undefined);
});

describe('POST /api/admin/email/jobs/:id/start', () => {
  it('writes the strict audit after the claim and before the enqueue', async () => {
    const { req, res } = await call(startHandler, 'POST');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.started',
      target: { kind: 'settings', id: 'job-1', displayName: 'Launch' },
    });
    expect(h.audit.mock.calls[0][1].details).not.toHaveProperty('subject');
    expect(h.claimForStart).toHaveBeenCalledWith('job-1', { startedBy: 'admin-1' });
    expect(h.claimForStart.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
    expect(h.audit.mock.invocationCallOrder[0]).toBeLessThan(h.sendToQueue.mock.invocationCallOrder[0]);
  });

  it('records a stored test-mode job as a real start, since the worker sends it to the full filter', async () => {
    h.claimForStart.mockResolvedValue({ ...draftJob, isTestMode: true });

    await call(startHandler, 'POST');

    expect(h.audit.mock.calls[0][1]).toMatchObject({ action: 'email.job.started' });
  });

  it('rejects an already-started job without auditing or enqueuing', async () => {
    h.claimForStart.mockResolvedValue(null);
    h.findById.mockResolvedValue({ ...draftJob, status: 'queued' });

    await expect(call(startHandler, 'POST')).rejects.toThrow('Job has already been started');

    expect(h.audit).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a missing job', async () => {
    h.claimForStart.mockResolvedValue(null);
    h.findById.mockResolvedValue(null);

    await expect(call(startHandler, 'POST')).rejects.toThrow('Job not found');
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

  it.each([
    {
      scenario: 'stored addresses only',
      testRecipients: undefined,
      expectedRecipients: ['stored@example.com', 'other-stored@example.com'],
    },
    {
      scenario: 'overlapping requested and stored addresses',
      testRecipients: ['requested@example.com', 'stored@example.com'],
      expectedRecipients: ['requested@example.com', 'stored@example.com', 'other-stored@example.com'],
    },
  ])('audits and enqueues the merged test recipients for $scenario', async ({ testRecipients, expectedRecipients }) => {
    h.claimForSending.mockResolvedValue({
      ...draftJob,
      testEmailAddresses: ['stored@example.com', 'other-stored@example.com'],
    });

    await call(sendHandler, 'POST', { testMode: true, testRecipients });

    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'email.job.test_sent',
      details: { testMode: true, testRecipientCount: expectedRecipients.length },
    });
    expect(h.sendToQueue.mock.calls[0][1]).toMatchObject({ testMode: true, testRecipients: expectedRecipients });
  });

  it('rejects test mode with no recipients without auditing or enqueuing', async () => {
    await expect(call(sendHandler, 'POST', { testMode: true })).rejects.toThrow('at least one test recipient');

    expect(h.audit).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a job that is already sending without auditing or enqueuing', async () => {
    h.claimForSending.mockResolvedValue(null);

    await expect(call(sendHandler, 'POST')).rejects.toThrow('currently being sent');

    expect(h.audit).not.toHaveBeenCalled();
    expect(h.sendToQueue).not.toHaveBeenCalled();
  });

  it('rejects a missing job', async () => {
    h.claimForSending.mockResolvedValue(null);
    h.findById.mockResolvedValue(null);

    await expect(call(sendHandler, 'POST')).rejects.toThrow('Job not found');
  });

  it('records recipient filter counts, never the addresses or ids', async () => {
    await call(sendHandler, 'POST', {
      recipientFilter: { allUsers: true, userIds: ['u1'], specificEmails: ['a@example.com', 'b@example.com'] },
    });

    const details = h.audit.mock.calls[0][1].details;
    expect(details.recipientFilter).toEqual({
      all: false,
      allUsers: true,
      allSubscribers: false,
      userIdCount: 1,
      subscriberIdCount: 0,
      specificEmailCount: 2,
    });
    expect(JSON.stringify(details)).not.toContain('example.com');
    expect(JSON.stringify(details)).not.toContain('u1');
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
