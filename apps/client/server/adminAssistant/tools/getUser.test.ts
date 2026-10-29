import { describe, it, expect, vi, beforeEach } from 'vitest';
import { USER_SECRET_FIELDS } from '@bike4mind/common';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminUserRef = vi.fn();
vi.mock('../resolveAdminUserRef', async importOriginal => ({
  ...(await importOriginal<typeof import('../resolveAdminUserRef')>()),
  resolveAdminUserRef: (...args: unknown[]) => resolveAdminUserRef(...args),
}));
const search = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { search: (...args: unknown[]) => search(...args) },
}));
const getActiveSubscriptionsForUser = vi.fn();
vi.mock('../../entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: (...args: unknown[]) => getActiveSubscriptionsForUser(...args),
}));
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [{ priceId: 'price_pro', name: 'Professional' }],
}));
vi.mock('../../entitlements', () => ({
  toEntitlementUser: (user: { id: string }) => ({ id: user.id }),
  getUserEntitlements: async () => ['base', 'plan:paid'],
}));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: {
    hasPaidStanding: async (_user: unknown, hasActivePlan: () => Promise<boolean>) => hasActivePlan(),
  },
}));

import { ADMIN_ASSISTANT_USER_FIELDS, getUserTool } from './getUser';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runTool = async (args: unknown) => JSON.parse(await getUserTool.implementation(context, undefined).toolFn(args));

const userDoc = (extra: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Ada',
  username: 'ada',
  email: 'ada@example.com',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  lastActiveAt: new Date('2026-10-01T00:00:00Z'),
  isAdmin: false,
  emailVerified: true,
  currentCredits: 42,
  apiKeyTrustApproved: true,
  organizationId: 'org-1',
  ...extra,
});

describe('getUserTool', () => {
  beforeEach(() => {
    resolveAdminUserRef.mockReset();
    search.mockReset().mockResolvedValue({ data: [], hasMore: false, total: 0 });
    getActiveSubscriptionsForUser.mockReset().mockResolvedValue([]);
  });

  it('returns not_found for an unknown user', async () => {
    resolveAdminUserRef.mockResolvedValue(null);

    expect(await runTool({ email: 'nobody@example.com' })).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('returns the whitelisted profile, orgs, subscriptions, entitlements and trust', async () => {
    resolveAdminUserRef.mockResolvedValue(userDoc());
    search.mockResolvedValue({
      data: [
        { id: 'o1', name: 'Owned', userId: USER_ID, adminUserIds: [] },
        { id: 'o2', name: 'Managed', userId: 'other', adminUserIds: [USER_ID], users: [{ userId: USER_ID }] },
        { id: 'o4', name: 'StaleAdmin', userId: 'other', adminUserIds: [USER_ID], users: [] },
        { id: 'o3', name: 'Joined', userId: 'other', adminUserIds: [] },
      ],
      hasMore: false,
      total: 3,
    });
    getActiveSubscriptionsForUser.mockResolvedValue([
      {
        priceId: 'price_pro',
        status: 'active',
        source: 'stripe',
        ownerType: 'Organization',
        periodEndsAt: new Date('2026-12-01T00:00:00Z'),
      },
    ]);

    const result = await runTool({ userId: USER_ID });

    expect(result.data.user).toEqual({
      id: USER_ID,
      name: 'Ada',
      username: 'ada',
      email: 'ada@example.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '2026-10-01T00:00:00.000Z',
      isAdmin: false,
      emailVerified: true,
      currentCredits: 42,
      apiKeyTrustApproved: true,
      organizationId: 'org-1',
    });
    expect(result.data.organizations).toEqual([
      { id: 'o1', name: 'Owned', role: 'owner' },
      { id: 'o2', name: 'Managed', role: 'admin' },
      { id: 'o4', name: 'StaleAdmin', role: 'member' },
      { id: 'o3', name: 'Joined', role: 'member' },
    ]);
    expect(result.data.organizationsTruncated).toBe(false);
    expect(Object.keys(result.data.user)).toEqual([...ADMIN_ASSISTANT_USER_FIELDS]);
    expect(result.data.subscriptions).toEqual([
      {
        plan: 'Professional',
        status: 'active',
        source: 'stripe',
        periodEndsAt: '2026-12-01T00:00:00.000Z',
        owner: 'organization',
      },
    ]);
    expect(result.data.entitlementKeys).toEqual(['base', 'plan:paid']);
    expect(result.data.apiKeyTrust).toEqual({ approved: true, hasPaidStanding: true });
  });

  it('output never contains password, mfa, stripeCustomerId or loginRecords', async () => {
    resolveAdminUserRef.mockResolvedValue(
      userDoc({
        password: 'hash-value',
        mfa: { totpSecret: 'totp-secret-value' },
        stripeCustomerId: 'cus_secret',
        loginRecords: [{ ip: '203.0.113.9' }],
      })
    );

    const raw = await getUserTool.implementation(context, undefined).toolFn({ userId: USER_ID });

    for (const leaked of ['hash-value', 'totp-secret-value', 'cus_secret', '203.0.113.9', 'loginRecords', 'mfa']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('requests 20 organizations and reports truncation from the search hasMore flag', async () => {
    resolveAdminUserRef.mockResolvedValue(userDoc());
    search.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, index) => ({ id: `o${index}`, name: `Org ${index}`, userId: 'x' })),
      hasMore: true,
      total: 25,
    });

    const result = await runTool({ userId: USER_ID });

    expect(search).toHaveBeenCalledWith('', { userId: USER_ID }, { page: 1, limit: 20 }, expect.anything());
    expect(result.data.organizations).toHaveLength(20);
    expect(result.data.organizationsTruncated).toBe(true);
  });

  it('never emits an unknown price id as the plan', async () => {
    resolveAdminUserRef.mockResolvedValue(userDoc());
    getActiveSubscriptionsForUser.mockResolvedValue([
      { priceId: 'price_secret_xyz', status: 'active', ownerType: 'User', periodEndsAt: new Date() },
    ]);

    const raw = await getUserTool.implementation(context, undefined).toolFn({ userId: USER_ID });

    expect(JSON.parse(raw).data.subscriptions[0].plan).toBe('unknown');
    expect(raw).not.toContain('price_secret_xyz');
  });

  it('hands the model userId and email properties in its JSON schema', () => {
    const { parameters } = getUserTool.implementation(context, undefined).toolSchema;

    expect(Object.keys((parameters as { properties: object }).properties)).toEqual(['userId', 'email']);
  });
});

describe('ADMIN_ASSISTANT_USER_FIELDS', () => {
  it('whitelist excludes every USER_SECRET_FIELDS entry', () => {
    const secrets: readonly string[] = USER_SECRET_FIELDS;
    expect(ADMIN_ASSISTANT_USER_FIELDS.filter(field => secrets.includes(field))).toEqual([]);
  });
});
