import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { MODERATION_PAGE_READ, missingAdminPermissionMessage } from '@bike4mind/common';

const mocks = vi.hoisted(() => ({
  findFeedback: vi.fn(),
  countDocuments: vi.fn(),
  findUser: vi.fn(),
  findSubscriptions: vi.fn(),
  searchOrganizations: vi.fn(),
  findOwnerSubscriptions: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', async () =>
  (await import('@server/middlewares/__tests__/adminApiMock')).adminApiMock()
);
vi.mock('@bike4mind/database', () => ({
  FeedbackModel: {
    findById: (...a: unknown[]) => ({ select: () => ({ lean: () => mocks.findFeedback(...a) }) }),
    countDocuments: (...a: unknown[]) => mocks.countDocuments(...a),
  },
  userRepository: { findById: (...a: unknown[]) => mocks.findUser(...a) },
  organizationRepository: { search: (...a: unknown[]) => mocks.searchOrganizations(...a) },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveUserSubscriptions: (...a: unknown[]) => mocks.findSubscriptions(...a),
    findActiveSubscriptionsByOwner: (...a: unknown[]) => mocks.findOwnerSubscriptions(...a),
  },
}));
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS_MAP: { price_pro: { name: 'Pro' } },
}));

import handler from '../reporter';

const FEEDBACK_ID = 'a'.repeat(24);
const USER_ID = 'b'.repeat(24);
const REPORTED_AT = new Date('2026-05-01T00:00:00Z');
const JOINED_AT = new Date('2025-01-02T03:04:05Z');
const EMAIL = 'reporter@example.com';

const call = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: FEEDBACK_ID, ...query } });
  (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findFeedback.mockResolvedValue({
    _id: FEEDBACK_ID,
    userId: USER_ID,
    userEmail: EMAIL,
    userIdVerified: true,
    createdAt: REPORTED_AT,
  });
  mocks.findUser.mockResolvedValue({ id: USER_ID, email: EMAIL, createdAt: JOINED_AT, isBanned: true });
  mocks.findSubscriptions.mockResolvedValue([{ priceId: 'price_unknown' }, { priceId: 'price_pro' }]);
  mocks.countDocuments.mockResolvedValue(2);
  mocks.searchOrganizations.mockResolvedValue({ data: [] });
  mocks.findOwnerSubscriptions.mockResolvedValue([]);
});

describe('GET /api/admin/feedback/[id]/reporter', () => {
  it('is jwt-only and declares MODERATION_PAGE_READ for GET', () => {
    const config = (handler as unknown as { _config?: { auth?: string; adminPermissions?: unknown } })._config;
    expect(config?.auth).toBe('jwtOnly');
    expect(config?.adminPermissions).toEqual({ GET: MODERATION_PAGE_READ });
  });

  it('refuses a delegate without a moderation read permission with 403 before reading anything', async () => {
    const delegate = { id: 'u2', isAdmin: false, adminPermissions: ['credits:adjust'] };
    await expect(call({}, delegate).promise).rejects.toMatchObject({
      statusCode: 403,
      message: missingAdminPermissionMessage(MODERATION_PAGE_READ),
    });
    expect(mocks.findFeedback).not.toHaveBeenCalled();
  });

  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s', async permission => {
    const { res, promise } = call({}, { id: 'u2', isAdmin: false, adminPermissions: [permission] });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });

  it('omits the plan for a delegate who may not read subscriptions', async () => {
    const { res, promise } = call({}, { id: 'u2', isAdmin: false, adminPermissions: ['users:moderate'] });
    await promise;
    expect(res._getJSONData().reporter).not.toHaveProperty('plan');
    expect(res._getJSONData().reporter).toMatchObject({ isBanned: true, earlierReports: 2 });
    expect(mocks.findSubscriptions).not.toHaveBeenCalled();
  });

  it('includes the plan for a support:read delegate, who holds the Credits page read', async () => {
    const { res, promise } = call({}, { id: 'u2', isAdmin: false, adminPermissions: ['support:read'] });
    await promise;
    expect(res._getJSONData().reporter.plan).toBe('Pro');
  });

  it('reports Team for a member of an organization with an active subscription', async () => {
    mocks.findSubscriptions.mockResolvedValue([]);
    mocks.searchOrganizations.mockResolvedValue({ data: [{ id: 'org1' }, { id: 'org2' }] });
    mocks.findOwnerSubscriptions.mockImplementation(async (_type: unknown, orgId: string) =>
      orgId === 'org2' ? [{ quantity: 3 }] : []
    );
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData().reporter.plan).toBe('Team');
  });

  it('reports Unknown plan for an active subscription whose price is not mapped', async () => {
    mocks.findSubscriptions.mockResolvedValue([{ priceId: 'price_unknown' }]);
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData().reporter.plan).toBe('Unknown plan');
  });

  it('returns no summary for a report whose userId came from an unauthenticated request body', async () => {
    mocks.findFeedback.mockResolvedValue({
      _id: FEEDBACK_ID,
      userId: USER_ID,
      userIdVerified: false,
      createdAt: REPORTED_AT,
    });
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toEqual({ reporter: null });
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it('returns no summary for an id in a casing no session writes', async () => {
    mocks.findFeedback.mockResolvedValue({
      _id: FEEDBACK_ID,
      userId: 'B'.repeat(24),
      userIdVerified: true,
      createdAt: REPORTED_AT,
    });
    const { res, promise } = call();
    await promise;
    expect(res._getJSONData()).toEqual({ reporter: null });
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it('trusts a report from before userIdVerified was recorded only when its email matches the account', async () => {
    mocks.findFeedback.mockResolvedValue({
      _id: FEEDBACK_ID,
      userId: USER_ID,
      userEmail: 'Reporter@Example.com',
      createdAt: REPORTED_AT,
    });
    const matched = call();
    await matched.promise;
    expect(matched.res._getJSONData().reporter).toMatchObject({ userId: USER_ID, exists: true });

    mocks.findFeedback.mockResolvedValue({
      _id: FEEDBACK_ID,
      userId: USER_ID,
      userEmail: 'someone@example.com',
      createdAt: REPORTED_AT,
    });
    const mismatched = call();
    await mismatched.promise;
    expect(mismatched.res._getJSONData()).toEqual({ reporter: null });
  });

  it('returns plan, account age, suspension and the count of reports filed before this one', async () => {
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData()).toEqual({
      reporter: {
        userId: USER_ID,
        exists: true,
        plan: 'Pro',
        createdAt: JOINED_AT.toISOString(),
        isBanned: true,
        earlierReports: 2,
      },
    });
    expect(mocks.countDocuments).toHaveBeenCalledWith({
      userId: USER_ID,
      userIdVerified: { $ne: false },
      createdAt: { $lt: REPORTED_AT },
    });
    expect(mocks.findSubscriptions).toHaveBeenCalledWith(USER_ID);
  });

  it('reports a null plan and zero earlier reports for a first-time free user', async () => {
    mocks.findUser.mockResolvedValue({ id: USER_ID, email: EMAIL, createdAt: JOINED_AT, isBanned: false });
    mocks.findSubscriptions.mockResolvedValue([]);
    mocks.countDocuments.mockResolvedValue(0);
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData().reporter).toMatchObject({ plan: null, isBanned: false, earlierReports: 0 });
  });

  it.each(['', 'waitlist-abc'])('returns no summary and queries nothing else for a legacy userId %j', async userId => {
    mocks.findFeedback.mockResolvedValue({ _id: FEEDBACK_ID, userId, userIdVerified: true, createdAt: REPORTED_AT });
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData()).toEqual({ reporter: null });
    expect(mocks.findUser).not.toHaveBeenCalled();
    expect(mocks.findSubscriptions).not.toHaveBeenCalled();
    expect(mocks.countDocuments).not.toHaveBeenCalled();
  });

  it('marks a deleted user as missing but still counts their earlier reports', async () => {
    mocks.findUser.mockResolvedValue(null);
    const { res, promise } = call();
    await promise;

    expect(res._getJSONData()).toEqual({
      reporter: { userId: USER_ID, exists: false, plan: null, createdAt: null, isBanned: false, earlierReports: 2 },
    });
  });

  it('returns 404 for a malformed feedback id without a lookup', async () => {
    await expect(call({ id: 'not-an-id' }).promise).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.findFeedback).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing report', async () => {
    mocks.findFeedback.mockResolvedValue(null);
    await expect(call().promise).rejects.toMatchObject({ statusCode: 404 });
  });
});
