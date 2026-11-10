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
  findById: vi.fn(),
  update: vi.fn(),
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
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.findById, update: h.update } }));
vi.mock('@bike4mind/services', () => ({ userService: { cancelEmailChange: vi.fn() } }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.publish } } }));
vi.mock('@bike4mind/server-utils/utils/mailer/emailHelpers', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/utils/mailer/emailHelpers')>()),
  generateVerificationLink: () => 'http://x/verify-email?t=1',
  getLogoUrl: () => 'logo',
  buildEmailLogoImg: () => '',
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: vi.fn().mockResolvedValue(null),
}));

import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

await import('../resend-email-change');

describe('POST /api/admin/users/[userId]/resend-email-change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly the resent timestamp', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
    });
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

    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update.mock.calls[0][0]).toStrictEqual({ id: 'user-1', pendingEmailSentAt: expect.any(Date) });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.change_resent',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
  });

  it('records user.email.change_cancelled when the pending token has expired', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
      pendingEmailExpires: new Date(Date.now() - 60_000),
    });

    await expect(
      h.handler!(
        {
          query: { userId: 'user-1' },
          user: { id: 'admin-1', username: 'admin', isAdmin: true },
          headers: {},
          logger: { info: vi.fn() },
        },
        { json: vi.fn() }
      )
    ).rejects.toThrow(/automatically cancelled/);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'user.email.change_cancelled',
        target: expect.objectContaining({ kind: 'user', id: 'user-1' }),
      })
    );
  });

  it('escapes the username and both addresses in the email body', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: '<b>x</b>',
      email: 'a&b@b.test',
      pendingEmail: '"new"@b.test',
      pendingEmailToken: 'tok',
    });

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json: vi.fn() }
    );

    const { body } = h.publish.mock.calls[0][0] as { body: string };
    expect(body).toContain('Hello &lt;b&gt;x&lt;/b&gt;,');
    expect(body).toContain('<strong>a&amp;b@b.test</strong> to <strong>&quot;new&quot;@b.test</strong>');
    expect(body).toContain('An administrator has resent your email change verification link.');
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
    expect(h.update).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a full administrator', { isAdmin: true }],
    ['a delegate with admin permissions', { adminPermissions: ['support:read'] }],
  ])('refuses a users:moderate delegate acting on %s', async (_label, adminFields) => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
      ...adminFields,
    });
    const req = {
      ...{ query: { userId: 'user-1' }, headers: {}, logger: { info: vi.fn() } },
      user: { id: 'mod-1', username: 'mod', isAdmin: false, adminPermissions: ['users:moderate'] },
    };

    await expect(h.handler!(req, { json: vi.fn() })).rejects.toThrow(
      'Only full administrators can resend an email change to users with admin access'
    );
    expect(h.update).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it('lets a full admin resend an email change for an admin user', async () => {
    h.findById.mockResolvedValue({
      id: 'user-1',
      username: 'u',
      email: 'a@b.test',
      isAdmin: true,
      pendingEmail: 'new@b.test',
      pendingEmailToken: 'tok',
    });

    await h.handler!(
      {
        query: { userId: 'user-1' },
        user: { id: 'admin-1', username: 'admin', isAdmin: true },
        headers: {},
        logger: { info: vi.fn() },
      },
      { json: vi.fn() }
    );

    expect(h.update).toHaveBeenCalledTimes(1);
  });
});
