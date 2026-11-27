import { ADMIN_NOTE_MAX_LENGTH } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  get: null as Handler | null,
  post: null as Handler | null,
  guard: null as null | ((req: Request, res: Response, next: () => void) => void),
  find: vi.fn(),
  list: vi.fn(),
  audit: vi.fn(),
  lock: vi.fn(),
  createNote: vi.fn(),
  findNotes: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: (guard: typeof mocks.guard) => {
        mocks.guard = guard;
        return chain;
      },
      get: (fn: Handler) => {
        mocks.get = fn;
        return chain;
      },
      post: (fn: Handler) => {
        mocks.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: { findById: mocks.find },
  FeedbackNoteModel: { create: mocks.createNote, find: mocks.findNotes },
  lockFeedbackNoteParent: mocks.lock,
  adminAuditLogRepository: { listForFeedback: mocks.list },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));
await import('../history');
const id = '507f1f77bcf86cd7994390fb';
async function call(
  method: 'GET' | 'POST',
  body?: unknown,
  user: Record<string, unknown> = { id: 'admin', isAdmin: true }
) {
  const { req, res } = createMocks({ method, body, query: { id } });
  const request = Object.assign(req, { user }) as unknown as Request;
  mocks.guard!(request, res as unknown as Response, () => {});
  await (method === 'GET' ? mocks.get! : mocks.post!)(request, res as unknown as Response);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockReturnValue({ select: () => ({ lean: async () => ({ _id: id, userId: 'reporter' }) }) });
  mocks.audit.mockResolvedValue({ id: 'audit1' });
  mocks.lock.mockResolvedValue({ feedbackId: id, userId: 'reporter', expiresAt: new Date(Date.now() + 86400000) });
  mocks.createNote.mockResolvedValue([{ _id: '507f1f77bcf86cd7994390fc' }]);
  mocks.findNotes.mockReturnValue({
    select: () => ({ lean: async () => [{ _id: '507f1f77bcf86cd7994390fc', body: 'Internal only' }] }),
  });
  mocks.list.mockResolvedValue({ entries: [], nextCursor: null });
});
describe('private feedback history', () => {
  it.each(['GET', 'POST'] as const)('denies a reporter access to %s', async method => {
    await expect(call(method, { note: 'private' }, { id: 'reporter', isAdmin: false })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'x'.repeat(ADMIN_NOTE_MAX_LENGTH + 1)])('rejects invalid note text', async note => {
    await expect(call('POST', { note })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('stores the note privately at the original deadline and only its IDs in the strict audit entry', async () => {
    const expiresAt = new Date(Date.now() + 42_000);
    mocks.lock.mockResolvedValue({ feedbackId: id, userId: 'reporter', expiresAt });
    const res = await call('POST', { note: '  Investigating the reproduction  ' });
    expect(res._getStatusCode()).toBe(201);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'feedback.note_added',
        details: { feedbackId: id, noteId: '507f1f77bcf86cd7994390fc' },
      })
    );
    expect(mocks.createNote).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          feedbackId: id,
          userId: 'reporter',
          body: 'Investigating the reproduction',
          expiresAt,
        }),
      ],
      expect.anything()
    );
    expect(JSON.stringify(res._getJSONData())).not.toContain('Investigating');
  });
  it('does not claim a saved note when auditing fails', async () => {
    mocks.audit.mockRejectedValue(new Error('audit unavailable'));
    await expect(call('POST', { note: 'Investigating' })).rejects.toThrow('audit unavailable');
  });
  it('returns history with author/time but not audit context or reporter details', async () => {
    mocks.list.mockResolvedValue({
      entries: [
        {
          id: 'audit1',
          occurredAt: new Date('2026-01-01Z'),
          actor: { name: 'Admin', email: 'private@example.com' },
          action: 'feedback.note_added',
          summary: 'added note',
          reason: 'Triaged',
          details: { feedbackId: id, noteId: '507f1f77bcf86cd7994390fc' },
          context: { ip: 'private' },
        },
      ],
      nextCursor: null,
    });
    const res = await call('GET');
    expect(res._getJSONData()).toEqual({
      items: [
        {
          id: 'audit1',
          occurredAt: '2026-01-01T00:00:00.000Z',
          author: 'Admin',
          summary: 'added note',
          reason: 'Triaged',
          note: 'Internal only',
        },
      ],
      nextCursor: null,
    });
    expect(mocks.list).toHaveBeenCalledWith(id, { limit: 25, cursor: undefined });
  });
  it.each(['GET', 'POST'] as const)('denies support-only delegates access to %s', async method => {
    await expect(
      call(method, { note: 'private' }, { id: 'support', adminPermissions: ['support:read'] })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.createNote).not.toHaveBeenCalled();
  });
  it('refuses writes after the parent/reporter is gone or purging', async () => {
    mocks.lock.mockResolvedValue(null);
    await expect(call('POST', { note: 'private' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.createNote).not.toHaveBeenCalled();
  });
  it('refuses new text at the original retention deadline', async () => {
    mocks.lock.mockResolvedValue({ feedbackId: id, userId: 'reporter', expiresAt: new Date(0) });
    await expect(call('POST', { note: 'private' })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.createNote).not.toHaveBeenCalled();
  });
  it('never falls back to a legacy inline body or an expired/missing note', async () => {
    mocks.list.mockResolvedValue({
      entries: [
        {
          id: 'legacy',
          occurredAt: new Date(),
          actor: { name: 'Admin' },
          action: 'feedback.note_added',
          summary: 'added note',
          details: { feedbackId: id, note: 'Legacy private text', noteId: '507f1f77bcf86cd7994390fc' },
        },
      ],
      nextCursor: null,
    });
    mocks.findNotes.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const res = await call('GET');
    expect(JSON.stringify(res._getJSONData())).not.toContain('Legacy private text');
    expect(res._getJSONData().items[0]).not.toHaveProperty('note');
    expect(mocks.findNotes).toHaveBeenCalledWith(
      expect.objectContaining({ feedbackId: id, expiresAt: { $gt: expect.any(Date) } })
    );
  });
});
