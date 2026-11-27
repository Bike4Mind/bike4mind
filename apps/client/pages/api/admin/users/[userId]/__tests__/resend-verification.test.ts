import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ForbiddenError,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionId,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;
type AdminIdentity = { isAdmin?: boolean; adminPermissions?: AdminPermissionId[] };

const h = vi.hoisted(() => ({
  options: null as unknown,
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  resend: vi.fn(),
  findById: vi.fn(),
  publish: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    h.options = options;
    const gated = (method: string, fn: Handler): Handler => {
      return async (req, res) => {
        const requirement = options.adminPermissions[method];
        if (requirement && !meetsAdminPermissionRequirement((req as { user?: AdminIdentity }).user, requirement)) {
          throw new ForbiddenError(missingAdminPermissionMessage(requirement));
        }
        return fn(req, res);
      };
    };
    const chain = {
      use: () => chain,
      post: (fn: Handler) => {
        h.handler = gated('POST', fn);
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@bike4mind/database', async () => ({
  userRepository: { findById: h.findById },
  ...(await import('@server/utils/__tests__/fakeTransaction')),
}));
vi.mock('@bike4mind/services', () => ({ userService: { resendEmailVerification: h.resend } }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', () => ({
  generateVerificationLink: (token: string) => `https://app.example.com/verify?token=${token}`,
  getLogoUrl: () => '',
  buildEmailLogoImg: () => '',
  escapeHtml: (value: string) => value,
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { fakeTransaction } from '@server/utils/__tests__/fakeTransaction';

await import('../resend-verification');

describe('POST /api/admin/users/[userId]/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeTransaction.reset();
    h.publish.mockResolvedValue(undefined);
    h.resend.mockImplementation(
      async (
        _params: unknown,
        adapters: { mailer: { sendEmailVerificationEmail: (user: object, token: string) => Promise<void> } }
      ) => {
        await adapters.mailer.sendEmailVerificationEmail({ username: 'ada', email: 'ada@example.com' }, 'tok');
      }
    );
  });

  const adminRequest = () => ({
    query: { userId: 'user-1' },
    user: { id: 'admin-1', username: 'admin', isAdmin: true },
    headers: {},
    logger: { info: vi.fn() },
  });

  it('publishes once when the transaction callback is retried', async () => {
    fakeTransaction.outcome = 'retryOnce';
    const json = vi.fn();

    await h.handler!(adminRequest(), { json });

    expect(fakeTransaction.runs).toBe(2);
    expect(h.resend).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ to: 'ada@example.com' }));
    expect(json).toHaveBeenCalledTimes(1);
  });

  it('publishes nothing and sends no response when the transaction aborts', async () => {
    fakeTransaction.outcome = 'abort';
    const json = vi.fn();

    await expect(h.handler!(adminRequest(), { json })).rejects.toThrow('Transaction aborted');
    expect(h.publish).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it('records user.email.verification_resent against the user', async () => {
    const json = vi.fn();

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json }
    );

    expect(h.resend).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.verification_resent',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
    expect(json).toHaveBeenCalledWith({ message: 'Verification email resent successfully' });
  });

  it('declares users:moderate for POST', () => {
    expect(h.options).toEqual(expect.objectContaining({ adminPermissions: { POST: 'users:moderate' } }));
  });

  it('refuses a delegate without users:moderate before reading the user', async () => {
    const req = {
      ...{ query: { userId: 'user-1' }, headers: {}, logger: { info: vi.fn() } },
      user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['support:read'] },
    };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(missingAdminPermissionMessage('users:moderate'));
    expect(h.findById).not.toHaveBeenCalled();
    expect(h.resend).not.toHaveBeenCalled();
  });

  it.each([
    ['a full administrator', { isAdmin: true }],
    ['a delegate with admin permissions', { adminPermissions: ['support:read'] }],
  ])('refuses a users:moderate delegate acting on %s', async (_label, adminFields) => {
    h.findById.mockResolvedValue({ id: 'user-1', ...adminFields });
    const req = {
      ...{ query: { userId: 'user-1' }, headers: {}, logger: { info: vi.fn() } },
      user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['users:moderate'] },
    };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(
      'Only full administrators can resend email verification to users with admin access'
    );
    expect(h.resend).not.toHaveBeenCalled();
  });

  it('lets a full admin resend verification to an admin user', async () => {
    h.findById.mockResolvedValue({ id: 'user-1', isAdmin: true });

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json: vi.fn() }
    );

    expect(h.resend).toHaveBeenCalledTimes(1);
  });
});
