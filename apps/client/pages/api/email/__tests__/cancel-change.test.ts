import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  cancelEmailChange: vi.fn(),
  logAuditEvent: vi.fn(),
  logAuthAudit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({ userService: { cancelEmailChange: h.cancelEmailChange } }));
// logAuditEvent writes a CounterLog row; an own email change must never reach it.
vi.mock('@server/utils/auditLog', () => ({ logAuditEvent: h.logAuditEvent }));
vi.mock('@server/utils/authAudit', () => ({ logAuthAudit: h.logAuthAudit }));

await import('../cancel-change');

const run = async () => {
  const req = { user: { id: 'user-1' }, headers: {}, logger: { info: vi.fn() } };
  const res = { json: vi.fn() };
  await h.handler!(req, res);
  return { req, res };
};

describe('POST /api/email/cancel-change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.cancelEmailChange.mockResolvedValue(undefined);
  });

  it('records the cancelled address in the user auth audit log, not CounterLog', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', pendingEmail: 'new@b.test' });

    const { req, res } = await run();

    expect(h.cancelEmailChange).toHaveBeenCalledWith({ userId: 'user-1' }, expect.anything());
    expect(h.logAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'email_change_cancelled',
      metadata: { newEmail: 'new@b.test' },
    });
    expect(h.logAuditEvent).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: 'Email change cancelled successfully' });
  });

  it('omits the address when no change was pending', async () => {
    h.findById.mockResolvedValue({ id: 'user-1' });

    const { req } = await run();

    expect(h.logAuthAudit).toHaveBeenCalledWith(req, {
      userId: 'user-1',
      event: 'email_change_cancelled',
      metadata: { newEmail: undefined },
    });
  });
});
