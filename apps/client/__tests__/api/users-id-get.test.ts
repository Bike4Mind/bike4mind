import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before any imports that depend on them
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: vi.fn(),
  },
  Project: { exists: vi.fn() },
  Session: { exists: vi.fn() },
  organizationRepository: { findMembershipOrgIds: vi.fn() },
  readAccessArms: vi.fn(user => [{ userId: user.id }]),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    // Return the handler function directly so we can call it in tests
    get: vi.fn((handler: (req: unknown, res: unknown) => Promise<void>) => handler),
  })),
}));

import handler from '../../pages/api/users/[id]/index';
import { Project, Session, User, organizationRepository } from '@bike4mind/database';

// Build a mock user document with all sensitive fields populated
function mockUserDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-aaa-111',
    username: 'johndoe',
    name: 'John Doe',
    email: 'john@example.com',
    photoUrl: 'https://example.com/photo.jpg',
    level: 'PaidUser',
    role: 'Engineer',
    team: 'Alpha',
    lastActiveAt: new Date('2026-01-01'),
    isOnline: true,
    isAdmin: false,
    currentCredits: 9999,
    oauthCredentials: { someProvider: 'secret-token' },
    googleDrive: { accessToken: 'drive-token', refreshToken: 'drive-refresh', expiresAt: new Date() },
    atlassianConnect: { accessToken: 'atlas-token', refreshToken: 'atlas-refresh', expiresAt: new Date() },
    securityQuestions: [{ question: 'Pet name?', answer: 'Fluffy' }],
    userNotes: [{ note: 'admin note', timestamp: '2026-01-01', userName: 'admin' }],
    slackSettings: { slackUserId: 'USLACK123' },
    loginRecords: [{ loginTime: new Date(), ip: '1.2.3.4', browser: 'Chrome' }],
    ...overrides,
  };
}

function mockReq(queryId: string, currentUserId: string, isAdmin = false) {
  return {
    query: { id: queryId },
    user: { id: currentUserId, isAdmin },
  };
}

function mockRes() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

describe('GET /api/users/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(organizationRepository.findMembershipOrgIds).mockResolvedValue([]);
    vi.mocked(Project.exists).mockResolvedValue(null);
    vi.mocked(Session.exists).mockResolvedValue(null);
  });

  it('returns 404 when user is not found', async () => {
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(null),
    });

    const req = mockReq('nonexistent-id', 'requester-id');
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
    expect(organizationRepository.findMembershipOrgIds).not.toHaveBeenCalled();
  });

  // Self / admin get the profile with credentials stripped (via redactUserSecretsForSelf),
  // but keep the self/admin-only fields (email, credits, ...) that the public DTO omits,
  // plus securityQuestions, which the profile-edit form loads and round-trips. userNotes
  // are admin-authored notes ABOUT the subject and are gated on the VIEWER, not the subject.
  it('returns the profile with credentials stripped for the same user (self)', async () => {
    const targetUser = mockUserDoc({ id: 'user-self-123' });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('user-self-123', 'user-self-123', false);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // self-only fields present (unlike the public DTO)
    expect(payload.id).toBe('user-self-123');
    expect(payload.email).toBe('john@example.com');
    expect(payload.currentCredits).toBe(9999);
    // edit-form fields kept
    expect(payload.securityQuestions).toBeDefined();
    // admin-only notes about this user are NOT returned to the user themselves
    expect(payload.userNotes).toBeUndefined();
    // credentials stripped
    expect(payload.oauthCredentials).toBeUndefined();
    expect(payload.loginRecords).toBeUndefined();
    expect(payload.googleDrive?.accessToken).toBeUndefined();
    expect(payload.atlassianConnect?.accessToken).toBeUndefined();
    expect(payload.slackSettings?.slackUserToken).toBeUndefined();
    expect(organizationRepository.findMembershipOrgIds).not.toHaveBeenCalled();
  });

  it('returns the profile with credentials stripped for an admin viewing another user', async () => {
    const targetUser = mockUserDoc({ id: 'user-target-456' });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('user-target-456', 'admin-user-789', true);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.id).toBe('user-target-456');
    expect(payload.email).toBe('john@example.com');
    expect(payload.securityQuestions).toBeDefined();
    expect(payload.userNotes).toBeDefined();
    expect(payload.oauthCredentials).toBeUndefined();
    expect(payload.loginRecords).toBeUndefined();
    expect(payload.googleDrive?.accessToken).toBeUndefined();
    expect(payload.atlassianConnect?.accessToken).toBeUndefined();
    expect(payload.slackSettings?.slackUserToken).toBeUndefined();
    expect(organizationRepository.findMembershipOrgIds).not.toHaveBeenCalled();
  });

  it('returns the profile with credentials stripped when an admin fetches their own profile', async () => {
    const targetUser = mockUserDoc({ id: 'admin-self-123', isAdmin: true });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('admin-self-123', 'admin-self-123', true);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.id).toBe('admin-self-123');
    expect(payload.isAdmin).toBe(true);
    expect(payload.oauthCredentials).toBeUndefined();
    expect(payload.loginRecords).toBeUndefined();
    expect(payload.googleDrive?.accessToken).toBeUndefined();
    expect(payload.atlassianConnect?.accessToken).toBeUndefined();
  });

  it('returns only identity fields when an unrelated non-admin user fetches another user', async () => {
    const targetUser = mockUserDoc({ id: 'user-target-456' });
    vi.mocked(organizationRepository.findMembershipOrgIds).mockImplementation(async id =>
      id === 'different-user-999' ? ['viewer-org'] : ['subject-org']
    );
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('user-target-456', 'different-user-999', false);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // Public fields must be present
    expect(payload.id).toBe('user-target-456');
    expect(payload.username).toBe('johndoe');
    expect(payload.name).toBe('John Doe');
    expect(payload.photoUrl).toBe('https://example.com/photo.jpg');
    expect(payload).not.toHaveProperty('level');
    expect(payload).not.toHaveProperty('role');
    expect(payload).not.toHaveProperty('team');
    expect(payload).not.toHaveProperty('isOnline');
    expect(payload).not.toHaveProperty('lastActiveAt');

    // Sensitive fields must be absent
    expect(payload.email).toBeUndefined();
    expect(payload.isAdmin).toBeUndefined();
    expect(payload.currentCredits).toBeUndefined();
    expect(payload.oauthCredentials).toBeUndefined();
    expect(payload.googleDrive).toBeUndefined();
    expect(payload.atlassianConnect).toBeUndefined();
    expect(payload.securityQuestions).toBeUndefined();
    expect(payload.userNotes).toBeUndefined();
    expect(payload.loginRecords).toBeUndefined();
    expect(payload.slackSettings).toBeUndefined();
  });

  it.each(['organization', 'project', 'notebook'] as const)(
    'includes presence and level for a shared %s colleague',
    async workspace => {
      (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue(mockUserDoc({ id: 'subject' })),
      });
      if (workspace === 'organization') {
        vi.mocked(organizationRepository.findMembershipOrgIds).mockResolvedValue(['shared-org']);
      } else if (workspace === 'project') {
        vi.mocked(Project.exists).mockResolvedValue({ _id: 'shared-project' } as never);
      } else {
        vi.mocked(Session.exists).mockResolvedValue({ _id: 'shared-notebook' } as never);
      }

      const res = mockRes();
      await (handler as (req: unknown, res: unknown) => Promise<void>)(mockReq('subject', 'viewer'), res);
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload).toMatchObject({
        id: 'subject',
        level: 'PaidUser',
        role: 'Engineer',
        team: 'Alpha',
        isOnline: true,
        lastActiveAt: new Date('2026-01-01'),
      });
      if (workspace !== 'organization') {
        const model = workspace === 'project' ? Project : Session;
        expect(model.exists).toHaveBeenCalledWith({
          deletedAt: null,
          $and: [{ $or: [{ userId: 'viewer' }] }, { $or: [{ userId: 'subject' }] }],
        });
      }
    }
  );

  // The redactor copies unknown keys; only the response schema strips them. This fails if the
  // self/admin branch stops going through respond().
  it('strips a field IUser does not declare from the self and admin views', async () => {
    for (const [viewer, isAdmin] of [
      ['user-self-123', false],
      ['admin-user-789', true],
    ] as const) {
      vi.clearAllMocks();
      (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        populate: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue(mockUserDoc({ id: 'user-self-123', notAUserField: 'x' })),
      });
      const res = mockRes();
      await (handler as (req: unknown, res: unknown) => Promise<void>)(mockReq('user-self-123', viewer, isAdmin), res);
      const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(payload.id).toBe('user-self-123');
      expect(payload).not.toHaveProperty('notAUserField');
    }
  });
});
