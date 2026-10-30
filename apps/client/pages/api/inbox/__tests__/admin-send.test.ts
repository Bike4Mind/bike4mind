// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type RouteFn = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  audit: vi.fn(),
  findUser: vi.fn(),
  createInbox: vi.fn(),
  sendToClient: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, RouteFn> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => routes[(req as { method?: string }).method ?? 'GET']?.(req, res),
      { post: (fn: RouteFn) => ((routes.POST = fn), chain) }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: RouteFn) => fn }));
vi.mock('@bike4mind/database', () => ({
  User: { findById: h.findUser },
  inboxRepository: { createInboxMessage: h.createInbox },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: h.sendToClient }));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'wss://example.test' } } }));
// parseAdminActionReason stays real so the 400s are the route's own.
vi.mock('@server/utils/adminAudit', async importOriginal => ({
  ...(await importOriginal<typeof import('@server/utils/adminAudit')>()),
  recordAdminActionFromRequest: h.audit,
}));

import handler from '../admin-send';

beforeEach(() => {
  vi.clearAllMocks();
  h.audit.mockResolvedValue(null);
  h.findUser.mockResolvedValue({ id: 'user-7', username: 'receiver' });
  h.createInbox.mockResolvedValue({ id: 'inbox-1' });
  h.sendToClient.mockResolvedValue(undefined);
});

describe('POST /api/inbox/admin-send', () => {
  it('records support.inbox.message_sent targeting the recipient, without the message body', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      body: { receiverId: 'user-7', title: 'Heads up', message: 'private message text', reason: 'Billing follow-up' },
    });
    (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    const input = h.audit.mock.calls[0][1];
    expect(input).toMatchObject({
      action: 'support.inbox.message_sent',
      target: { kind: 'user', id: 'user-7', displayName: 'receiver' },
      reason: 'Billing follow-up',
      details: { inboxMessageId: 'inbox-1' },
    });
    expect(JSON.stringify(input)).not.toContain('private message text');
    expect(h.createInbox.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it.each([
    [undefined, /outdated version/],
    ['no', /at least/i],
  ])('rejects reason %j with no inbox write, no push and no audit', async reason => {
    const { req, res } = createMocks({
      method: 'POST',
      body: { receiverId: 'user-7', title: 'Heads up', message: 'text', reason },
    });
    (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };

    await expect((handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res)).rejects.toThrow();

    expect(h.createInbox).not.toHaveBeenCalled();
    expect(h.sendToClient).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});
