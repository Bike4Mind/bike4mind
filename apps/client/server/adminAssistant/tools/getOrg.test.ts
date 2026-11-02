import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ORGANIZATION_SECRET_FIELDS } from '@bike4mind/common';
import type { ToolContext } from '@bike4mind/services/llm/tools';

const resolveAdminOrgRef = vi.fn();
vi.mock('../resolveAdminOrgRef', () => ({
  resolveAdminOrgRef: (...args: unknown[]) => resolveAdminOrgRef(...args),
}));
const resolveUserNames = vi.fn();
vi.mock('../../utils/resolveUserNames', () => ({
  resolveUserNames: (...args: unknown[]) => resolveUserNames(...args),
}));
const findActiveSubscriptionsByOwners = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwners: (...args: unknown[]) => findActiveSubscriptionsByOwners(...args),
  },
}));
vi.mock('@client/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [{ priceId: 'price_team', name: 'Team' }],
}));

import { ADMIN_ASSISTANT_ORG_FIELDS, getOrgTool } from './getOrg';

const ORG_ID = '65f1a2b3c4d5e6f708192a3b';

const context = {
  user: { isAdmin: true },
  userId: 'admin-1',
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
} as unknown as Omit<ToolContext, 'config'>;

const runRaw = (args: unknown) => getOrgTool.implementation(context, undefined).toolFn(args);
const runTool = async (args: unknown) => JSON.parse(await runRaw(args));

const orgDoc = (extra: Record<string, unknown> = {}) => ({
  id: ORG_ID,
  name: 'Acme',
  personal: false,
  description: 'Rockets',
  billingContact: 'billing@acme.example',
  seats: 10,
  currentCredits: 5000,
  lastCreditsPurchasedAt: new Date('2026-09-01T00:00:00Z'),
  maxCreditsPerMember: null,
  storageLimit: 1000,
  currentStorageSize: 2048,
  allowedGroupTypes: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  userId: 'owner-1',
  adminUserIds: ['manager-1'],
  users: [{ userId: 'owner-1' }, { userId: 'manager-1' }, { userId: 'member-1' }],
  ...extra,
});

describe('getOrgTool', () => {
  beforeEach(() => {
    resolveAdminOrgRef.mockReset();
    resolveUserNames.mockReset().mockResolvedValue(
      new Map([
        ['owner-1', 'Olive'],
        ['manager-1', 'Max'],
      ])
    );
    findActiveSubscriptionsByOwners.mockReset().mockResolvedValue([]);
  });

  it('passes a resolver failure straight through', async () => {
    const ambiguous = { ok: false, error: 'ambiguous', message: 'pick one', candidates: [{ id: 'o1' }] };
    resolveAdminOrgRef.mockResolvedValue(ambiguous);

    expect(await runTool({ name: 'Acme' })).toEqual(ambiguous);
  });

  it('returns the whitelisted profile, owner, members with role and subscriptions', async () => {
    resolveAdminOrgRef.mockResolvedValue({ ok: true, org: orgDoc({ systemPrompt: 'Be terse.' }) });
    findActiveSubscriptionsByOwners.mockResolvedValue([
      {
        priceId: 'price_team',
        status: 'active',
        source: 'stripe',
        quantity: 10,
        periodEndsAt: new Date('2026-12-01T00:00:00Z'),
      },
    ]);

    const result = await runTool({ orgId: ORG_ID });

    expect(findActiveSubscriptionsByOwners).toHaveBeenCalledWith('Organization', [ORG_ID]);
    expect(result.data.organization).toEqual({
      id: ORG_ID,
      name: 'Acme',
      personal: false,
      description: 'Rockets',
      billingContact: 'billing@acme.example',
      seats: 10,
      currentCredits: 5000,
      lastCreditsPurchasedAt: '2026-09-01T00:00:00.000Z',
      maxCreditsPerMember: null,
      storageLimit: 1000,
      currentStorageSize: 2048,
      allowedGroupTypes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      hasSystemPrompt: true,
    });
    expect(result.data.owner).toEqual({ userId: 'owner-1', name: 'Olive' });
    expect(result.data.memberCount).toBe(3);
    expect(result.data.members).toEqual([
      { userId: 'owner-1', name: 'Olive', role: 'owner' },
      { userId: 'manager-1', name: 'Max', role: 'admin' },
      { userId: 'member-1', name: null, role: 'member' },
    ]);
    expect(result.data.membersTruncated).toBe(false);
    expect(result.data.subscriptions).toEqual([
      { plan: 'Team', status: 'active', source: 'stripe', periodEndsAt: '2026-12-01T00:00:00.000Z', seats: 10 },
    ]);
  });

  it('caps the member list at 25 and resolves names only for the rows it shows', async () => {
    const users = Array.from({ length: 30 }, (_, index) => ({ userId: `m${index}` }));
    resolveAdminOrgRef.mockResolvedValue({ ok: true, org: orgDoc({ users }) });

    const result = await runTool({ orgId: ORG_ID });

    expect(result.data.memberCount).toBe(30);
    expect(result.data.members).toHaveLength(25);
    expect(result.data.membersTruncated).toBe(true);
    expect(resolveUserNames.mock.calls[0][0]).toHaveLength(26);
  });

  it('never emits secrets or the system prompt text', async () => {
    resolveAdminOrgRef.mockResolvedValue({
      ok: true,
      org: orgDoc({
        stripeCustomerId: 'cus_secret',
        signupGrantUnlockCount: 7,
        systemPrompt: 'prompt-body-text',
        userDetails: [{ id: 'member-1', email: 'member@acme.example', usedCredits: 1 }],
      }),
    });

    const raw = await runRaw({ orgId: ORG_ID });

    for (const leaked of ['cus_secret', 'signupGrantUnlockCount', 'prompt-body-text', 'member@acme.example']) {
      expect(raw).not.toContain(leaked);
    }
  });

  it('hands the model orgId and name properties in its JSON schema', () => {
    const { parameters } = getOrgTool.implementation(context, undefined).toolSchema;

    expect(Object.keys((parameters as { properties: object }).properties)).toEqual(['orgId', 'name']);
  });
});

describe('ADMIN_ASSISTANT_ORG_FIELDS', () => {
  it('whitelist excludes every ORGANIZATION_SECRET_FIELDS entry and the system prompt', () => {
    const excluded: readonly string[] = [...ORGANIZATION_SECRET_FIELDS, 'systemPrompt'];
    expect(ADMIN_ASSISTANT_ORG_FIELDS.filter(field => excluded.includes(field))).toEqual([]);
  });
});
