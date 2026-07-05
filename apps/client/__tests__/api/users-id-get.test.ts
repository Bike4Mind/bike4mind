import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before any imports that depend on them
vi.mock('@bike4mind/database', () => ({
  User: {
    findById: vi.fn(),
  },
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: vi.fn(() => ({
    // Return the handler function directly so we can call it in tests
    get: vi.fn((handler: (req: unknown, res: unknown) => Promise<void>) => handler),
  })),
}));

import handler from '../../pages/api/users/[id]/index';
import { User } from '@bike4mind/database';

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
  });

  it('returns full profile when requester is the same user (self)', async () => {
    const targetUser = mockUserDoc({ id: 'user-self-123' });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('user-self-123', 'user-self-123', false);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    // Full document must be returned untouched - not the public DTO
    expect(res.json).toHaveBeenCalledWith(targetUser);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toEqual(targetUser);
  });

  it('returns full profile when requester is an admin viewing another user', async () => {
    const targetUser = mockUserDoc({ id: 'user-target-456' });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    const req = mockReq('user-target-456', 'admin-user-789', true);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    // Full document must be returned untouched - not the public DTO
    expect(res.json).toHaveBeenCalledWith(targetUser);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toEqual(targetUser);
  });

  it('returns full profile when an admin fetches their own profile', async () => {
    const targetUser = mockUserDoc({ id: 'admin-self-123', isAdmin: true });
    (User.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      populate: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue(targetUser),
    });

    // isSelf is true AND isAdmin is true - isSelf branch wins, full doc returned
    const req = mockReq('admin-self-123', 'admin-self-123', true);
    const res = mockRes();

    await (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

    expect(res.json).toHaveBeenCalledWith(targetUser);
    const payload = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload).toEqual(targetUser);
  });

  it('returns only public fields when a non-admin user fetches another user', async () => {
    const targetUser = mockUserDoc({ id: 'user-target-456' });
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
    expect(payload.level).toBe('PaidUser');
    expect(payload.role).toBe('Engineer');
    expect(payload.team).toBe('Alpha');
    expect(payload.isOnline).toBe(true);

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
});
