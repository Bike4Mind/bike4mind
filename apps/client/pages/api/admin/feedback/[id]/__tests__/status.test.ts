import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  handler: null as null | ((req: Request, res: Response) => Promise<unknown>),
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  options: null as null | Record<string, unknown>,
  findById: vi.fn(),
  updateOne: vi.fn(),
  audit: vi.fn(),
  findAuditEntry: vi.fn(),
  exists: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: Record<string, unknown>) => {
    mocks.options = options;
    const chain = {
      use: (guard: (req: Request, res: Response, next: () => void) => void) => {
        mocks.guard = guard;
        return chain;
      },
      patch: (fn: (req: Request, res: Response) => Promise<unknown>) => {
        mocks.handler = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: mocks.findById, updateOne: mocks.updateOne, exists: mocks.exists },
  adminAuditLogRepository: { findById: mocks.findAuditEntry },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: `${id}@example.com` }),
}));

await import('../status');

const FEEDBACK_ID = '507f1f77bcf86cd7994390fb';

const call = async (
  body: unknown,
  user: Record<string, unknown> = { id: 'admin1', isAdmin: true },
  id: string = FEEDBACK_ID
) => {
  const data = body as Record<string, unknown>;
  const { req, res } = createMocks({
    method: 'PATCH',
    body: { ...(data.status === 'Closed' ? { resolution: 'fixed' } : {}), ...data },
    query: { id },
  });
  const request = Object.assign(req, { user }) as unknown as Request;
  mocks.guard!(request, res as unknown as Response, () => {});
  await mocks.handler!(request, res as unknown as Response);
  return res;
};

const stored = (status: string) =>
  mocks.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ userId: 'reporter1', handledAuditEntryId: 'audit1', status }) }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  stored('New');
  mocks.updateOne.mockResolvedValue({ matchedCount: 1 });
  mocks.audit.mockResolvedValue({ id: 'audit1' });
  mocks.exists.mockResolvedValue({ _id: 'another' });
  mocks.findAuditEntry.mockResolvedValue({
    id: 'audit1',
    action: 'feedback.status_changed',
    details: { feedbackId: FEEDBACK_ID },
    changes: [{ field: 'status', before: 'New', after: 'Closed' }],
  });
});

describe('PATCH /api/admin/feedback/[id]/status', () => {
  it('requires a close resolution and validates duplicate targets before auditing', async () => {
    await expect(call({ status: 'Closed', resolution: undefined })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ status: 'Closed', resolution: 'duplicate' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      call({ status: 'Closed', resolution: 'duplicate', resolutionDuplicateId: FEEDBACK_ID })
    ).rejects.toMatchObject({ statusCode: 400 });
    mocks.exists.mockResolvedValue(null);
    await expect(
      call({ status: 'Closed', resolution: 'duplicate', resolutionDuplicateId: '507f1f77bcf86cd799439000' })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('records a duplicate resolution and link in the same audit entry', async () => {
    await call({ status: 'Closed', resolution: 'duplicate', resolutionDuplicateId: '507f1f77bcf86cd799439000' });
    expect(mocks.updateOne.mock.calls[0][1].$set).toMatchObject({
      resolution: 'duplicate',
      resolutionDuplicateId: '507f1f77bcf86cd799439000',
    });
    expect(mocks.audit.mock.calls[0][1].changes).toEqual(
      expect.arrayContaining([
        { field: 'resolution', before: null, after: 'duplicate' },
        { field: 'resolutionDuplicateId', before: null, after: '507f1f77bcf86cd799439000' },
      ])
    );
  });

  it('restores the original resolution when undoing a reopen', async () => {
    stored('New');
    mocks.findAuditEntry.mockResolvedValue({
      action: 'feedback.status_changed',
      details: { feedbackId: FEEDBACK_ID },
      changes: [
        { field: 'status', before: 'Closed', after: 'New' },
        { field: 'resolution', before: 'wont_fix', after: null },
      ],
    });
    await call({ status: 'Closed', resolution: undefined, undoOf: 'audit1' });
    expect(mocks.updateOne.mock.calls[0][1].$set.resolution).toBe('wont_fix');
  });

  it('is first-party JWT only and denies a user without users:moderate', async () => {
    expect(mocks.options).toMatchObject({ auth: 'jwtOnly' });
    await expect(
      call({ status: 'Closed' }, { id: 'u1', isAdmin: false, adminPermissions: ['support:read'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('rejects a status outside the enum and any other field', async () => {
    await expect(call({ status: 'Resolved' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ status: 'Closed', handledBy: 'someone' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('records the acting admin on the report and in the Admin log with before and after', async () => {
    const res = await call({ status: 'Closed', expectedStatus: 'New' });

    expect(res._getStatusCode()).toBe(200);
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: FEEDBACK_ID, status: 'New' },
      {
        $set: {
          status: 'Closed',
          resolution: 'fixed',
          handledBy: 'admin1',
          handledAt: expect.any(Date),
          handledAuditEntryId: 'audit1',
        },
        $unset: { resolutionDuplicateId: '' },
      }
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'feedback.status_changed',
        target: { kind: 'user', id: 'reporter1', displayName: 'reporter1@example.com' },
        changes: [
          { field: 'status', before: 'New', after: 'Closed' },
          { field: 'resolution', before: null, after: 'fixed' },
        ],
        details: { feedbackId: FEEDBACK_ID },
      })
    );
    expect(res._getJSONData()).toMatchObject({
      status: 'Closed',
      previousStatus: 'New',
      handledBy: 'admin1',
      auditEntryId: 'audit1',
    });
  });

  it('attributes an impersonated change to the impersonating admin', async () => {
    await call({ status: 'Closed' }, { id: 'admin1', isAdmin: true, impersonatedBy: 'realAdmin' });
    expect(mocks.updateOne.mock.calls[0][1].$set.handledBy).toBe('realAdmin');
  });

  it('logs an undo as its own entry that names the change it reverses', async () => {
    stored('Closed');
    await call({ status: 'New', expectedStatus: 'Closed', undoOf: 'audit1' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'feedback.status_changed',
        changes: [{ field: 'status', before: 'Closed', after: 'New' }],
        details: { feedbackId: FEEDBACK_ID, undoOf: 'audit1' },
        summary: expect.stringContaining('undid'),
      })
    );
  });

  it.each([
    ['a missing entry', null],
    ['another action', { action: 'feedback.deleted', details: { feedbackId: FEEDBACK_ID } }],
    ['another report', { action: 'feedback.status_changed', details: { feedbackId: 'other' } }],
  ])('rejects an undoOf naming %s', async (_label, entry) => {
    stored('Closed');
    mocks.findAuditEntry.mockResolvedValue(entry);
    await expect(call({ status: 'New', expectedStatus: 'Closed', undoOf: 'audit9' })).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('refuses an undo with 409 when the report no longer sits where the named change left it', async () => {
    stored('InProgress');
    await expect(call({ status: 'New', undoOf: 'audit1' })).rejects.toMatchObject({ statusCode: 409 });
    stored('Closed');
    await expect(call({ status: 'InProgress', undoOf: 'audit1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('does not report success when the Admin log write fails', async () => {
    mocks.audit.mockRejectedValue(new Error('audit write failed'));
    await expect(call({ status: 'Closed' })).rejects.toThrow('audit write failed');
  });

  it('refuses with 409 when the report moved since the admin saw it', async () => {
    stored('InProgress');
    await expect(call({ status: 'New', expectedStatus: 'Closed', undoOf: 'audit1' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('refuses an older undo after later transitions return to the same status', async () => {
    mocks.findById.mockReturnValue({
      select: () => ({
        lean: async () => ({ userId: 'reporter1', status: 'Closed', handledAuditEntryId: 'audit3' }),
      }),
    });
    await expect(call({ status: 'New', expectedStatus: 'Closed', undoOf: 'audit1' })).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('refuses a status change when its required audit entry was not written', async () => {
    mocks.audit.mockResolvedValue(null);
    await expect(call({ status: 'Closed' })).rejects.toThrow('requires an audit entry');
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it('refuses with 409 when the report changes between the read and the write', async () => {
    mocks.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(call({ status: 'Closed' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.audit).toHaveBeenCalled();
  });

  it('writes and logs nothing when the status is already the requested one', async () => {
    stored('Closed');
    const res = await call({ status: 'Closed' });
    expect(res._getJSONData()).toMatchObject({ status: 'Closed', previousStatus: 'Closed', auditEntryId: null });
    expect(mocks.updateOne).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed or missing report', async () => {
    await expect(call({ status: 'Closed' }, undefined, 'not-an-id')).rejects.toMatchObject({ statusCode: 404 });
    mocks.findById.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await expect(call({ status: 'Closed' })).rejects.toMatchObject({ statusCode: 404 });
  });
});
