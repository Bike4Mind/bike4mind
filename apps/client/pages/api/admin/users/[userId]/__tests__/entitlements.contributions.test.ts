import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Rows an overlay would contribute through b4mContributions.entitlementGrants. The env is set before
// the registry loads, since it reads the internal staff domains at module load.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS = 'staff.example.com';
});

vi.mock('@client/app/premium-generated/premiumEntitlementGrants.generated', () => ({
  premiumEntitlementGrants: {
    tagGrants: [{ tag: 'example-pro', entitlements: ['example:pro'] }],
    impliedEntitlements: [{ ifHeld: 'example:pro', alsoGrant: ['example:addon'] }],
    internalStaffEntitlements: ['example:staff'],
  },
}));

const { mockUserFind, mockSubs, mockPartnerKeys } = vi.hoisted(() => ({
  mockUserFind: vi.fn(),
  mockSubs: vi.fn(),
  mockPartnerKeys: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/utils', () => ({
  BadRequestError: class BadRequestError extends Error {},
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

vi.mock('@server/entitlements/activeSubscriptions', () => ({
  getActiveSubscriptionsForUser: (...a: unknown[]) => mockSubs(...a),
}));

vi.mock('@server/entitlements/partnerRules', () => ({
  partnerEntitlementsForEmail: (...a: unknown[]) => mockPartnerKeys(...a),
}));

import handler from '../entitlements';

type Row = { key: string; held: boolean; grantTag?: string; sources: { type: string; detail: string }[] };

const ADMIN = { id: 'admin1', isAdmin: true };

const report = async (target: Record<string, unknown>): Promise<Row[]> => {
  mockUserFind.mockResolvedValue({ id: 'u1', tags: [], isAdmin: false, email: null, emailVerified: false, ...target });
  const { req, res } = createMocks({ method: 'GET', query: { userId: 'u1' } });
  (req as Record<string, unknown>).user = ADMIN;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res._getJSONData().entitlements;
};

const row = (rows: Row[], key: string): Row => {
  const found = rows.find(r => r.key === key);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
};

beforeEach(() => {
  mockUserFind.mockReset();
  mockSubs.mockReset().mockResolvedValue([]);
  mockPartnerKeys.mockReset().mockResolvedValue(new Set());
});

describe('GET /api/admin/users/:userId/entitlements with contributed registry rows', () => {
  it('lists every contributed key alongside the built-in ones, unheld for a bare user', async () => {
    const rows = await report({});

    for (const key of ['example:pro', 'example:addon', 'example:staff']) {
      expect(row(rows, key)).toMatchObject({ held: false, sources: [] });
    }
    expect(row(rows, 'example:pro').grantTag).toBe('example-pro');
    expect(row(rows, 'example:addon').grantTag).toBeUndefined();
  });

  it('attributes a contributed tag grant to its tag and the key it implies to an implied source', async () => {
    const rows = await report({ tags: ['Example-Pro'] });

    expect(row(rows, 'example:pro')).toMatchObject({ held: true, sources: [{ type: 'tag', detail: 'Example-Pro' }] });
    expect(row(rows, 'example:addon')).toMatchObject({
      held: true,
      sources: [{ type: 'implied', detail: 'example:pro' }],
    });
  });

  it('grants a contributed internal staff key to a verified staff-domain email only', async () => {
    const verified = await report({ email: 'someone@staff.example.com', emailVerified: true });
    expect(row(verified, 'example:staff')).toMatchObject({
      held: true,
      sources: [{ type: 'domain', detail: 'staff.example.com' }],
    });

    const unverified = await report({ email: 'someone@staff.example.com', emailVerified: false });
    expect(row(unverified, 'example:staff').held).toBe(false);
  });

  it('applies the admin and developer bypass to contributed keys', async () => {
    const admin = await report({ isAdmin: true });
    expect(row(admin, 'example:pro').sources).toContainEqual({ type: 'admin-bypass', detail: 'Super Admin' });

    const developer = await report({ tags: ['developer'] });
    expect(row(developer, 'example:addon').sources).toContainEqual({
      type: 'developer-bypass',
      detail: 'Developer tag',
    });
  });
});
