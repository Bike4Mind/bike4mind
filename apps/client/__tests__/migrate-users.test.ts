import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies before importing
const mockCreateUser = vi.fn();
const mockFindByEmail = vi.fn();
const mockUpdate = vi.fn();
const mockAddMember = vi.fn();
const mockLogEvent = vi.fn();
const mockPublish = vi.fn();

vi.mock('@bike4mind/services', () => ({
  userService: {
    createUser: (...args: unknown[]) => mockCreateUser(...args),
  },
  organizationService: {
    addMember: (...args: unknown[]) => mockAddMember(...args),
  },
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: (...args: unknown[]) => unknown) => fn(),
}));

vi.mock('@bike4mind/database/auth', () => ({
  userRepository: {
    findByEmail: (...args: unknown[]) => mockFindByEmail(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: {},
}));

vi.mock('@server/utils/analyticsLog', () => ({
  logEvent: (...args: unknown[]) => mockLogEvent(...args),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (handler: (...args: unknown[]) => unknown) => handler,
  }),
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ForbiddenError';
    }
  },
  BadRequestError: class BadRequestError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'BadRequestError';
    }
  },
}));

vi.mock('@server/utils/eventBus', () => ({
  EmailEvents: {
    Send: {
      publish: (...args: unknown[]) => mockPublish(...args),
    },
  },
}));

// Mutable logo URL so a test can exercise the empty-LOGO_URL (fork) path, where
// getLogoUrl() returns '' and buildEmailLogoImg() therefore omits the <img> entirely.
const { mockLogo } = vi.hoisted(() => ({ mockLogo: { url: 'https://example.com/logo.png' } }));
vi.mock('@server/utils/mailer/emailHelpers', () => ({
  getLogoUrl: () => mockLogo.url,
  buildEmailLogoImg: (brand: string, logoUrl = mockLogo.url) =>
    logoUrl ? `<img src="${logoUrl}" alt="${brand} Logo" class="logo" />` : '',
}));

vi.mock('@bike4mind/common', () => ({
  RegInviteEvents: {
    MIGRATE_REGINVITE: 'Migration Email Sent',
  },
  // migrate.ts reads APP_URL via requireEnv (no brand fallback). The mock
  // must export it or the handler throws before sending the email. Value is irrelevant
  // to these assertions (no link/host is asserted).
  requireEnv: (_name: string, value?: string) => value ?? 'https://app.example.com',
}));

describe('/api/reg-invites/migrate', () => {
  let handler: (...args: unknown[]) => unknown;
  let mockReq: Record<string, unknown>;
  let mockRes: { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLogo.url = 'https://example.com/logo.png';

    mockRes = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    mockReq = {
      user: { id: 'admin-123', isAdmin: true },
      ability: {},
    };

    // Dynamic import to apply mocks
    const migrateModule = await import('@pages/api/reg-invites/migrate');
    handler = migrateModule.default;
  });

  it('rejects non-admin users', async () => {
    mockReq.user = { id: 'user-1', isAdmin: false };
    mockReq.body = { usersData: [{ email: 'test@test.com', name: 'Test' }], sendEmail: true };

    await expect(handler(mockReq, mockRes)).rejects.toThrow('Only admins can perform user migration');
  });

  it('creates a new user when email does not exist', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-1',
      name: 'John Doe',
      email: 'john@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'john@example.com', name: 'John Doe' }],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockFindByEmail).toHaveBeenCalledWith('john@example.com');
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'JohnDoe',
        email: 'john@example.com',
        name: 'John Doe',
        // Passwordless shell account: null password (not a fake hash) + flag false.
        record: { password: null, hasUsablePassword: false },
      }),
      expect.any(Object)
    );
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'User migration initiated successfully',
        createdUsers: expect.arrayContaining([
          expect.objectContaining({
            name: 'John Doe',
            email: 'john@example.com',
          }),
        ]),
      })
    );
  });

  it('handles existing users without creating a new one', async () => {
    mockFindByEmail.mockResolvedValue({
      id: 'existing-user-1',
      name: 'Jane Doe',
      email: 'jane@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'jane@example.com', name: 'Jane Doe' }],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockFindByEmail).toHaveBeenCalledWith('jane@example.com');
    expect(mockCreateUser).not.toHaveBeenCalled();
    // Passwordless: existing users get no reset-token update. With no orgId there's
    // nothing to persist, so update is not called at all (org assignment is the only
    // remaining reason to update).
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('sends migration email when sendEmail is true', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-2',
      name: 'Bob',
      email: 'bob@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'bob@example.com', name: 'Bob' }],
      sendEmail: true,
    };

    await handler(mockReq, mockRes);

    expect(mockPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'bob@example.com',
        // Brand externalized; APP_NAME unset in tests means no brand in the subject.
        subject: 'Welcome - Sign In',
        body: expect.stringContaining('Hello Bob'),
      })
    );
    // With LOGO_URL configured, the email embeds the logo <img>.
    expect(mockPublish.mock.calls[0][0].body).toContain('<img');
  });

  it('omits the logo img when LOGO_URL is unset (fork empty-logo path)', async () => {
    mockLogo.url = ''; // getLogoUrl() → '' → buildEmailLogoImg returns ''
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({ id: 'new-user-9', name: 'Carol', email: 'carol@example.com' });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'carol@example.com', name: 'Carol' }],
      sendEmail: true,
    };

    await handler(mockReq, mockRes);

    expect(mockPublish).toHaveBeenCalled();
    const body = mockPublish.mock.calls[0][0].body as string;
    // Fork path: no LOGO_URL -> no <img>, but the email still renders its content.
    expect(body).not.toContain('<img');
    expect(body).toContain('Hello Carol');
  });

  it('does not send an email or return a temp password when sendEmail is false', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-3',
      name: 'Alice',
      email: 'alice@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'alice@example.com', name: 'Alice' }],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockPublish).not.toHaveBeenCalled();

    const jsonCall = mockRes.json.mock.calls[0][0];
    const user = jsonCall.createdUsers[0];
    // Passwordless: no temp password is generated or returned; the user signs in via OTC.
    expect(user).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    expect(user.tempPassword).toBeUndefined();
  });

  it('adds user to organization when orgId is provided', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-4',
      name: 'Charlie',
      email: 'charlie@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'charlie@example.com', name: 'Charlie' }],
      sendEmail: false,
      orgId: 'org-456',
    };

    await handler(mockReq, mockRes);

    // Org assignment now goes through organizationService.addMember (which sets
    // the user's organizationId itself), not a separate userRepository.update.
    expect(mockAddMember).toHaveBeenCalledWith(
      mockReq.user,
      { organizationId: 'org-456', userId: 'new-user-4', force: true },
      expect.objectContaining({ db: expect.any(Object) })
    );
  });

  it('does not add user to organization when orgId is not provided', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-5',
      name: 'Dave',
      email: 'dave@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'dave@example.com', name: 'Dave' }],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockAddMember).not.toHaveBeenCalled();
  });

  it('logs migration event for each user', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockResolvedValue({
      id: 'new-user-6',
      name: 'Eve',
      email: 'eve@example.com',
    });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'eve@example.com', name: 'Eve' }],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockLogEvent).toHaveBeenCalledWith(
      {
        userId: 'admin-123',
        type: 'Migration Email Sent',
        metadata: { email: 'eve@example.com', migratedBy: 'admin-123' },
      },
      { ability: {} }
    );
  });

  it('processes multiple users in a single request', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser
      .mockResolvedValueOnce({ id: 'u1', name: 'User One', email: 'one@example.com' })
      .mockResolvedValueOnce({ id: 'u2', name: 'User Two', email: 'two@example.com' });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [
        { email: 'one@example.com', name: 'User One' },
        { email: 'two@example.com', name: 'User Two' },
      ],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    expect(mockCreateUser).toHaveBeenCalledTimes(2);
    expect(mockLogEvent).toHaveBeenCalledTimes(2);

    const jsonCall = mockRes.json.mock.calls[0][0];
    expect(jsonCall.createdUsers).toHaveLength(2);
  });

  it('continues processing when one user fails', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser
      .mockRejectedValueOnce(new Error('Duplicate username'))
      .mockResolvedValueOnce({ id: 'u2', name: 'User Two', email: 'two@example.com' });
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [
        { email: 'one@example.com', name: 'User One' },
        { email: 'two@example.com', name: 'User Two' },
      ],
      sendEmail: false,
    };

    await handler(mockReq, mockRes);

    const jsonCall = mockRes.json.mock.calls[0][0];
    expect(jsonCall.createdUsers).toHaveLength(1);
    expect(jsonCall.createdUsers[0].email).toBe('two@example.com');
  });

  it('throws BadRequestError when all users fail', async () => {
    mockFindByEmail.mockResolvedValue(null);
    mockCreateUser.mockRejectedValue(new Error('Duplicate'));
    mockUpdate.mockResolvedValue(null);

    mockReq.body = {
      usersData: [{ email: 'fail@example.com', name: 'Fail User' }],
      sendEmail: false,
    };

    await expect(handler(mockReq, mockRes)).rejects.toThrow('No users were migrated. Check server logs for details.');
  });

  it('rejects invalid request body', async () => {
    mockReq.body = {
      usersData: [{ email: 'not-an-email', name: '' }],
      sendEmail: true,
    };

    await expect(handler(mockReq, mockRes)).rejects.toThrow();
  });
});
