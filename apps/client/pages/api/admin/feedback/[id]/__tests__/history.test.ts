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
  adminAuditLogRepository: { listForFeedback: mocks.list },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: id }),
}));
await import('../history');
const id = '507f1f77bcf86cd7994390fb';
async function call(method: 'GET' | 'POST', body?: unknown, user = { id: 'admin', isAdmin: true }) {
  const { req, res } = createMocks({ method, body, query: { id } });
  const request = Object.assign(req, { user }) as unknown as Request;
  mocks.guard!(request, res as unknown as Response, () => {});
  await (method === 'GET' ? mocks.get! : mocks.post!)(request, res as unknown as Response);
  return res;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockReturnValue({ select: () => ({ lean: async () => ({ userId: 'reporter' }) }) });
  mocks.audit.mockResolvedValue({ id: 'audit1' });
  mocks.list.mockResolvedValue({ entries: [], nextCursor: null });
});
describe('private feedback history', () => {
  it.each(['GET', 'POST'] as const)('denies a reporter access to %s', async method => {
    await expect(call(method, { note: 'private' }, { id: 'reporter', isAdmin: false })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it.each(['', '   ', 'x'.repeat(2001)])('rejects invalid note text', async note => {
    await expect(call('POST', { note })).rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('stores the note only in the strict audit entry with the owning report id', async () => {
    const res = await call('POST', { note: '  Investigating the reproduction  ' });
    expect(res._getStatusCode()).toBe(201);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'feedback.note_added',
        details: { feedbackId: id, note: 'Investigating the reproduction' },
      })
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
          details: { feedbackId: id, note: 'Internal only' },
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
});
