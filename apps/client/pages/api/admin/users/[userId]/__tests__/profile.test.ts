import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestError, ConflictError } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findById: vi.fn(),
  existsOtherUserWithEmail: vi.fn(),
  validateUsernameChange: vi.fn(),
  writeUserUpdate: vi.fn(),
  requestEmailChange: vi.fn(),
  requireStepUp: vi.fn(),
  buildEmailChangeMailer: vi.fn(),
  publishEmailChangeMessages: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    use: () => chain,
    patch: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/csrfProtection', () => ({ csrfProtection: vi.fn() }));
vi.mock('@server/auth/stepUp', () => ({ requireStepUp: h.requireStepUp }));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findById, existsOtherUserWithEmail: h.existsOtherUserWithEmail },
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/services', () => ({
  userService: {
    validateUsernameChange: h.validateUsernameChange,
    writeUserUpdate: h.writeUserUpdate,
    requestEmailChange: h.requestEmailChange,
    EMAIL_IN_USE_MESSAGE: 'That email address is already in use.',
  },
}));
vi.mock('@server/users/emailChangeMailer', () => ({
  buildEmailChangeMailer: h.buildEmailChangeMailer,
  publishEmailChangeMessages: h.publishEmailChangeMessages,
}));
vi.mock('@server/utils/adminAudit', () => ({
  parseAdminActionReason: (value: unknown) => {
    if (typeof value !== 'string') throw new BadRequestError('A reason is required');
    return value;
  },
  recordAdminActionFromRequest: h.record,
}));

await import('../profile');

const REASON = 'Customer request';

const storedUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  name: 'Ada Lovelace',
  username: 'ada',
  email: 'ada@example.com',
  pendingEmail: null,
  ...overrides,
});

const makeReq = (body: unknown, { isAdmin = true, userId = 'user-1' as unknown } = {}) => ({
  query: { userId },
  body,
  user: { id: 'admin-1', isAdmin },
  logger: { error: vi.fn() },
});

const run = async (body: unknown, options?: Parameters<typeof makeReq>[1]) => {
  const json = vi.fn();
  const req = makeReq(body, options);
  await h.handler!(req, { json });
  return { json, req };
};

const rejection = async (body: unknown, options?: Parameters<typeof makeReq>[1]) => {
  try {
    await run(body, options);
  } catch (error) {
    return error as Error & { statusCode?: number; additionalInfo?: Record<string, unknown> };
  }
  throw new Error('expected the handler to reject');
};

describe('PATCH /api/admin/users/[userId]/profile', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.findById.mockResolvedValue(storedUser());
    h.existsOtherUserWithEmail.mockResolvedValue(false);
    h.validateUsernameChange.mockImplementation(
      async (_user: unknown, params: { username?: string }) =>
        params.username && (params.username = params.username.trim())
    );
    h.buildEmailChangeMailer.mockReturnValue({ mailer: true });
  });

  it('refuses a non-admin before reading the user', async () => {
    const error = await rejection({ name: 'X', reason: REASON }, { isAdmin: false });

    expect(error.message).toMatch(/admin access required/i);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('rejects a missing user id', async () => {
    const error = await rejection({ name: 'X', reason: REASON }, { userId: null });

    expect(error.message).toBe('Invalid user ID');
  });

  it('rejects a malformed email inline, on the email field', async () => {
    const error = await rejection({ email: 'not-an-email', reason: REASON });

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Enter a valid email address.');
    expect(error.additionalInfo).toEqual({ field: 'email' });
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('rejects a blank name on the name field, since the account requires one', async () => {
    const error = await rejection({ name: '   ', reason: REASON });

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Enter a name.');
    expect(error.additionalInfo).toEqual({ field: 'name' });
  });

  it('requires a reason before any write', async () => {
    const error = await rejection({ name: 'Ada King' });

    expect(error.message).toMatch(/reason/i);
    expect(h.findById).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    h.findById.mockResolvedValue(null);

    const error = await rejection({ name: 'Ada King', reason: REASON });

    expect(error.statusCode).toBe(404);
  });

  it('tags a taken username with the username field', async () => {
    h.validateUsernameChange.mockRejectedValue(new ConflictError('That username is taken.'));

    const error = await rejection({ username: 'taken', reason: REASON });

    expect(error.statusCode).toBe(409);
    expect(error.additionalInfo).toEqual({ field: 'username' });
    expect(h.writeUserUpdate).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });

  it('passes a non-HTTP write failure through untagged', async () => {
    const failure = new Error('connection lost');
    h.writeUserUpdate.mockRejectedValue(failure);

    await expect(run({ username: 'ada2', reason: REASON })).rejects.toBe(failure);
    expect(failure).not.toHaveProperty('additionalInfo');
  });

  it('refuses an edit that changes nothing', async () => {
    const error = await rejection({
      name: 'Ada Lovelace',
      username: 'ada',
      email: ' ADA@example.com ',
      reason: REASON,
    });

    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Change the name, username or email.');
    expect(h.requireStepUp).not.toHaveBeenCalled();
    expect(h.writeUserUpdate).not.toHaveBeenCalled();
  });

  it('writes a new name and username and audits them with the reason', async () => {
    const { json } = await run({ name: '  Ada King ', username: ' ada2 ', reason: REASON });

    expect(h.validateUsernameChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      { username: 'ada2' },
      expect.anything(),
      { allowReservedUsername: true }
    );
    expect(h.writeUserUpdate).toHaveBeenCalledWith(expect.anything(), {
      id: 'user-1',
      name: 'Ada King',
      username: 'ada2',
    });
    expect(h.requireStepUp).not.toHaveBeenCalled();
    expect(h.requestEmailChange).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(expect.anything(), {
      action: 'user.identity.updated',
      target: { kind: 'user', id: 'user-1', displayName: 'ada@example.com' },
      summary: 'updated name, username',
      reason: REASON,
      changes: [
        { field: 'name', before: 'Ada Lovelace', after: 'Ada King' },
        { field: 'username', before: 'ada', after: 'ada2' },
      ],
      details: undefined,
    });
    expect(h.publishEmailChangeMessages).toHaveBeenCalledWith([], expect.anything(), 'user-1');
    expect(json).toHaveBeenCalledWith({
      name: 'Ada King',
      username: 'ada2',
      email: 'ada@example.com',
      pendingEmail: null,
    });
  });

  it('records a name on an account that had none', async () => {
    h.findById.mockResolvedValue(storedUser({ name: undefined, pendingEmail: 'old@example.com' }));

    const { json } = await run({ name: 'Ada', reason: REASON });

    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'name', before: null, after: 'Ada' }] })
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ username: 'ada', pendingEmail: 'old@example.com' }));
  });

  it('starts a verified email change instead of writing the address', async () => {
    h.findById.mockResolvedValue(storedUser({ pendingEmail: 'stale@example.com' }));

    const { json, req } = await run({ email: ' New@Example.com ', reason: REASON });

    expect(h.requireStepUp).toHaveBeenCalledWith(req);
    expect(h.existsOtherUserWithEmail).toHaveBeenCalledWith('new@example.com', 'user-1');
    expect(h.writeUserUpdate).not.toHaveBeenCalled();
    expect(h.buildEmailChangeMailer).toHaveBeenCalledWith(expect.any(Array), { byAdmin: true });
    expect(h.requestEmailChange).toHaveBeenCalledWith(
      { userId: 'user-1', newEmail: 'new@example.com' },
      { db: { users: expect.anything() }, mailer: { mailer: true } }
    );
    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: 'updated pendingEmail',
        changes: [{ field: 'pendingEmail', before: 'stale@example.com', after: 'new@example.com' }],
        details: { currentEmail: 'ada@example.com' },
      })
    );
    expect(json).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      username: 'ada',
      email: 'ada@example.com',
      pendingEmail: 'new@example.com',
    });
  });

  it('adds a first email to an emailless account', async () => {
    h.findById.mockResolvedValue(storedUser({ email: null, pendingEmail: undefined }));

    await run({ email: 'first@example.com', reason: REASON });

    expect(h.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        target: { kind: 'user', id: 'user-1', displayName: 'ada' },
        changes: [{ field: 'pendingEmail', before: null, after: 'first@example.com' }],
        details: { currentEmail: null },
      })
    );
  });

  it('reports an email another account holds on the email field, without starting a change', async () => {
    h.existsOtherUserWithEmail.mockResolvedValue(true);

    const error = await rejection({ name: 'Ada King', email: 'taken@example.com', reason: REASON });

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('That email address is already in use.');
    expect(error.additionalInfo).toEqual({ field: 'email' });
    expect(h.writeUserUpdate).not.toHaveBeenCalled();
    expect(h.requestEmailChange).not.toHaveBeenCalled();
  });
});
