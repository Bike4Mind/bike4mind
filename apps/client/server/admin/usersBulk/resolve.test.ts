import { describe, expect, it, vi } from 'vitest';
import { ADMIN_USERS_BULK_MAX, ADMIN_USERS_BULK_MAX_CREDIT_TOTAL } from '@client/app/utils/adminUsersBulk';
import {
  RESOLVE_MAX_PAGES,
  RESOLVE_PAGE_SIZE,
  cohortHashOf,
  creditDeltaFor,
  previewAdminUsersBulk,
  resolveAdminUsersBulk,
  type BulkUser,
  type ResolveDeps,
} from './resolve';

const NOW = new Date('2026-10-27T00:00:00Z');
const SELF = 'a'.repeat(24);

const hexId = (n: number) => n.toString(16).padStart(24, '0');
const user = (n: number, overrides: Partial<BulkUser> = {}): BulkUser => ({
  id: hexId(n),
  name: `User ${n}`,
  email: `u${n}@example.com`,
  username: `u${n}`,
  isAdmin: false,
  isBanned: false,
  isModerated: false,
  tags: [],
  currentCredits: 100,
  disputePending: false,
  moderationStatus: null,
  ...overrides,
});

/** A filter reader over `total` users in id order, every `adminEvery`-th one an admin. */
function pagedDeps(total: number, adminEvery = 0) {
  const all = Array.from({ length: total }, (_, i) =>
    user(i + 1, { isAdmin: adminEvery > 0 && (i + 1) % adminEvery === 0 })
  );
  const readPage = vi.fn(async (afterId: string | null, limit: number) =>
    all.filter(row => afterId === null || row.id > afterId).slice(0, limit)
  );
  const deps: ResolveDeps = { findUsersByIds: vi.fn(), openFilterPages: vi.fn(async () => readPage) };
  return { deps, readPage };
}

describe('resolveAdminUsersBulk', () => {
  it('excludes the calling admin and other admins from an id target', async () => {
    const deps: ResolveDeps = {
      findUsersByIds: vi.fn(async () => [user(1), user(2, { isAdmin: true }), user(3, { id: SELF })]),
      openFilterPages: vi.fn(),
    };
    const cohort = await resolveAdminUsersBulk(
      { kind: 'ids', userIds: [hexId(1), hexId(2), SELF, hexId(1)] },
      [SELF],
      deps,
      NOW
    );
    expect(deps.findUsersByIds).toHaveBeenCalledWith([hexId(1), hexId(2), SELF]);
    expect(cohort).toMatchObject({ matched: 3, excluded: { self: 1, admins: 1 }, overCap: false });
    expect(cohort.eligible.map(row => row.id)).toEqual([hexId(1)]);
  });

  it('pages a filter in id order and stops at a short page', async () => {
    const { deps, readPage } = pagedDeps(450);
    const cohort = await resolveAdminUsersBulk({ kind: 'filter', filter: {} }, [SELF], deps, NOW);
    expect(cohort).toMatchObject({ matched: 450, overCap: false });
    expect(cohort.eligible).toHaveLength(450);
    expect(readPage.mock.calls.map(([afterId]) => afterId)).toEqual([null, hexId(200), hexId(400)]);
  });

  it('stops once more than the cap is eligible and reports overCap', async () => {
    const { deps, readPage } = pagedDeps(5_000);
    const cohort = await resolveAdminUsersBulk({ kind: 'filter', filter: {} }, [SELF], deps, NOW);
    expect(cohort.overCap).toBe(true);
    expect(cohort.eligible.length).toBeGreaterThan(ADMIN_USERS_BULK_MAX);
    expect(readPage).toHaveBeenCalledTimes(Math.ceil((ADMIN_USERS_BULK_MAX + 1) / RESOLVE_PAGE_SIZE));
  });

  it('is bounded even when every row is excluded, and refuses what it could not finish reading', async () => {
    const { deps, readPage } = pagedDeps(50_000, 1);
    const cohort = await resolveAdminUsersBulk({ kind: 'filter', filter: {} }, [SELF], deps, NOW);
    expect(readPage).toHaveBeenCalledTimes(RESOLVE_MAX_PAGES);
    expect(cohort).toMatchObject({ eligible: [], overCap: true });
  });
});

describe('creditDeltaFor', () => {
  const adjust = (mode: 'add' | 'subtract' | 'set', amount: number) =>
    ({ type: 'adjustCredits', mode, amount }) as const;

  it('floors a subtraction at the current balance', () => {
    expect(creditDeltaFor(adjust('subtract', 500), 120)).toBe(-120);
    expect(creditDeltaFor(adjust('subtract', 50), 120)).toBe(-50);
    expect(creditDeltaFor(adjust('subtract', 50), -10)).toBe(0);
  });

  it('turns set into a per-user delta and contain into a zeroing deduction', () => {
    expect(creditDeltaFor(adjust('set', 0), 120)).toBe(-120);
    expect(creditDeltaFor(adjust('set', 200), 120)).toBe(80);
    expect(creditDeltaFor({ type: 'contain' }, 75)).toBe(-75);
    expect(Object.is(creditDeltaFor({ type: 'contain' }, 0), 0)).toBe(true);
  });
});

describe('previewAdminUsersBulk', () => {
  it('counts already-applied users, keys to revoke and credits, writing nothing', async () => {
    const users = [user(1, { isBanned: true, currentCredits: 0 }), user(2, { currentCredits: 40 }), user(3)];
    const blockedEmailDomains = vi.fn(async () => new Set<string>());
    const countLiveApiKeys = vi.fn(
      async () =>
        new Map([
          [hexId(2), 2],
          [hexId(3), 1],
        ])
    );
    const preview = await previewAdminUsersBulk(
      { matched: 4, eligible: users, excluded: { self: 1, admins: 0 }, overCap: false },
      { type: 'contain' },
      { countLiveApiKeys, blockedEmailDomains }
    );
    expect(preview).toEqual({
      matched: 4,
      eligible: 3,
      excluded: { self: 1, admins: 0 },
      alreadyApplied: 1,
      overCap: false,
      apiKeysToRevoke: 3,
      creditsDelta: 140,
      creditsOverCap: false,
      cohortHash: cohortHashOf(users),
      emailDomains: null,
      sample: users.map(row => ({ id: row.id, name: row.name, email: row.email })),
    });
  });

  it('counts the keys a suspend disables only for users it would ban', async () => {
    const users = [user(1, { isBanned: true }), user(2)];
    const preview = await previewAdminUsersBulk(
      { matched: 2, eligible: users, excluded: { self: 0, admins: 0 }, overCap: false },
      { type: 'suspend' },
      {
        countLiveApiKeys: async () =>
          new Map([
            [hexId(1), 4],
            [hexId(2), 1],
          ]),
        blockedEmailDomains: async () => new Set(),
      }
    );
    expect(preview).toMatchObject({ alreadyApplied: 1, apiKeysToRevoke: 1, creditsDelta: 0 });
  });
});

describe('previewAdminUsersBulk email domains', () => {
  const cohort = (users: BulkUser[]) => ({
    matched: users.length,
    eligible: users,
    excluded: { self: 0, admins: 0 },
    overCap: false,
  });

  it('is null and never reads the list unless the action blocks domains', async () => {
    const blockedEmailDomains = vi.fn(async () => new Set<string>());
    const preview = await previewAdminUsersBulk(
      cohort([user(1)]),
      { type: 'contain' },
      { countLiveApiKeys: async () => new Map(), blockedEmailDomains }
    );
    expect(preview.emailDomains).toBeNull();
    expect(blockedEmailDomains).not.toHaveBeenCalled();
  });

  it('plans the domains of every eligible user, including already-contained ones', async () => {
    const users = [
      user(1, { email: 'a@acme.com' }),
      user(2, { email: 'b@gmail.com' }),
      user(3, { email: 'c@old.com', isBanned: true, currentCredits: 0 }),
    ];
    const preview = await previewAdminUsersBulk(
      cohort(users),
      { type: 'contain', blockEmailDomains: true },
      { countLiveApiKeys: async () => new Map(), blockedEmailDomains: async () => new Set(['old.com']) }
    );
    expect(preview.alreadyApplied).toBe(1);
    expect(preview.emailDomains).toEqual({
      toBlock: ['acme.com'],
      alreadyBlocked: ['old.com'],
      notOwned: ['gmail.com'],
    });
  });
});

describe('cohort binding and the credit total', () => {
  it('hashes the eligible ids independent of order', () => {
    expect(cohortHashOf([user(2), user(1)])).toBe(cohortHashOf([user(1), user(2)]));
    expect(cohortHashOf([user(1)])).not.toBe(cohortHashOf([user(2)]));
  });

  it('flags a batch that would add more than the total ceiling', async () => {
    const users = Array.from({ length: 11 }, (_, i) => user(i + 1));
    const preview = await previewAdminUsersBulk(
      { matched: 11, eligible: users, excluded: { self: 0, admins: 0 }, overCap: false },
      { type: 'adjustCredits', mode: 'add', amount: ADMIN_USERS_BULK_MAX_CREDIT_TOTAL / 10 },
      { countLiveApiKeys: async () => new Map(), blockedEmailDomains: async () => new Set() }
    );
    expect(preview).toMatchObject({ creditsOverCap: true, creditsDelta: -1_100_000 });
  });
});
