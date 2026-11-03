import { describe, expect, it, vi } from 'vitest';
import { MAX_BULK_ABUSE_BATCH, type BulkAbuseActions, type IUser } from '@bike4mind/common';
import {
  bulkAbuseFingerprint,
  clawbackAmount,
  executeBulkAbuse,
  isPaidAccount,
  userIdUpperBound,
  previewBulkAbuseCounts,
  resolveBulkAbuseCohort,
  type BulkAbuseCohortAdapters,
  type BulkAbuseExecuteAdapters,
} from './bulkAbuseResponse';

const ACTOR_ID = 'a'.repeat(24);
const id = (n: number) => n.toString(16).padStart(24, '0');

const makeUser = (n: number, overrides: Partial<IUser> = {}): IUser =>
  ({
    id: id(n),
    email: `bot${n}@np.kashre.com`,
    username: `bot${n}`,
    isAdmin: false,
    isBanned: false,
    level: 'DemoUser',
    subscribedUntil: null,
    stripeCustomerId: null,
    currentCredits: 100,
    ...overrides,
  }) as IUser;

type CreditRow = { ownerId: string; credits: number; type: string; transactionId?: string; reason?: string };

const ALL_ACTIONS: BulkAbuseActions = {
  ban: true,
  revokeApiKeys: true,
  revokeSessions: true,
  clawbackFreeCredits: true,
};
const ONLY = (action: keyof BulkAbuseActions): BulkAbuseActions => ({
  ban: false,
  revokeApiKeys: false,
  revokeSessions: false,
  clawbackFreeCredits: false,
  [action]: true,
});

// A tiny matcher for the filters the service sends: equality, $in, $ne.
function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, condition]) => {
    const value = row[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const ops = condition as Record<string, unknown>;
      if ('$in' in ops) return (ops.$in as unknown[]).includes(value);
      if ('$ne' in ops) return value !== ops.$ne;
    }
    return value === condition;
  });
}

function cohortAdapters({
  users = [] as IUser[],
  orgs = [] as { userId: string; adminUserIds?: string[]; users?: { userId: string; permissions: string[] }[] }[],
  credits = [] as CreditRow[],
} = {}) {
  const find = vi.fn(async (filter: Record<string, unknown>, options?: { limit?: number }) => {
    if ('_id' in filter && (filter._id as { $in?: string[] }).$in) {
      const ids = (filter._id as { $in: string[] }).$in;
      return users.filter(user => ids.includes(user.id));
    }
    const { $gt: after, $lte: upTo } = (filter._id ?? {}) as { $gt?: string; $lte?: string };
    const page = users.filter(user => (!after || user.id > after) && (!upTo || user.id <= upTo));
    return options?.limit ? page.slice(0, options.limit) : page;
  });
  const adapters: BulkAbuseCohortAdapters = {
    db: {
      users: { find },
      organizations: { find: vi.fn(async () => orgs) } as unknown as BulkAbuseCohortAdapters['db']['organizations'],
      creditTransactions: {
        find: vi.fn(async (filter: Record<string, unknown>) =>
          credits.filter(row => matches(row as unknown as Record<string, unknown>, filter))
        ),
      } as unknown as BulkAbuseCohortAdapters['db']['creditTransactions'],
    },
  };
  return { adapters, find };
}

describe('isPaidAccount', () => {
  it('is false for a plain free account', () => {
    expect(isPaidAccount(makeUser(1))).toBe(false);
  });

  it.each<[string, Partial<IUser>]>([
    ['a paid tier', { level: 'PaidUser' }],
    ['a Stripe customer', { stripeCustomerId: 'cus_1' }],
    ['a past credit purchase', { lastCreditsPurchasedAt: new Date('2026-01-01') }],
    ['a live subscription', { subscribedUntil: '2999-01-01' }],
  ])('is true for %s', (_label, overrides) => {
    expect(isPaidAccount(makeUser(1, overrides))).toBe(true);
  });

  it('ignores an expired subscription', () => {
    expect(isPaidAccount(makeUser(1, { subscribedUntil: '2000-01-01' }))).toBe(false);
  });
});

describe('resolveBulkAbuseCohort', () => {
  it('matches the domain and its subdomains and anchors the regex at the end', async () => {
    const { adapters, find } = cohortAdapters({
      users: [makeUser(1), makeUser(2, { email: 'x@kashre.com' }), makeUser(3, { email: 'x@notkashre.com' })],
    });
    const cohort = await resolveBulkAbuseCohort({ kind: 'domain', domain: '@Kashre.com' }, ACTOR_ID, adapters);

    expect(cohort.included.map(user => user.id)).toEqual([id(1), id(2)]);
    const [filter, options] = find.mock.calls[0];
    expect(filter.email).toEqual({
      $regex: '@(?:[^@]+[.\u3002\uff0e\uff61])?kashre[.\u3002\uff0e\uff61]com[.\u3002\uff0e\uff61]*$',
      $options: 'i',
    });
    expect(new RegExp(String((filter.email as { $regex: string }).$regex), 'i').test('x@notkashre.com')).toBe(false);
    expect(options).toEqual({ sort: { _id: 1 }, limit: MAX_BULK_ABUSE_BATCH + 1 });
  });

  it('matches a trailing dot and fullwidth dots in the stored email', async () => {
    const { adapters, find } = cohortAdapters({ users: [makeUser(1)] });
    await resolveBulkAbuseCohort({ kind: 'domain', domain: 'kashre.com' }, ACTOR_ID, adapters);

    const regex = new RegExp(String((find.mock.calls[0][0].email as { $regex: string }).$regex), 'i');
    expect(regex.test('bot@kashre.com.')).toBe(true);
    expect(regex.test('bot@kashre\uff0ecom')).toBe(true);
    expect(regex.test('bot@np\u3002kashre.com')).toBe(true);
    expect(regex.test('bot@notkashre.com.')).toBe(false);
  });

  it('excludes the actor, admins, system, paid accounts, purchasers and org owners with reasons', async () => {
    const users = [
      makeUser(1),
      makeUser(2, { isAdmin: true }),
      makeUser(3, { isSystem: true }),
      makeUser(4, { stripeCustomerId: 'cus_1' }),
      makeUser(5),
      makeUser(6),
      makeUser(7),
      { ...makeUser(8), id: ACTOR_ID },
    ];
    const { adapters } = cohortAdapters({
      users,
      orgs: [{ userId: id(5) }, { userId: 'f'.repeat(24), adminUserIds: [id(6)] }],
      credits: [{ ownerId: id(7), credits: 500, type: 'purchase', ownerType: 'User' } as CreditRow],
    });
    const cohort = await resolveBulkAbuseCohort(
      { kind: 'users', userIds: users.map(user => user.id) },
      ACTOR_ID,
      adapters
    );

    expect(cohort.included.map(user => user.id)).toEqual([id(1)]);
    expect(Object.fromEntries(cohort.excluded.map(entry => [entry.userId, entry.reason]))).toEqual({
      [id(2)]: 'admin',
      [id(3)]: 'system',
      [id(4)]: 'paid',
      [id(5)]: 'org_owner',
      [id(6)]: 'org_owner',
      [id(7)]: 'paid',
      [ACTOR_ID]: 'self',
    });
  });

  it('excludes seat members of an organization with org_member, by pointer or by users[] row', async () => {
    const users = [makeUser(1), makeUser(2, { organizationId: 'a'.repeat(24) }), makeUser(3), makeUser(4), makeUser(5)];
    const { adapters } = cohortAdapters({
      users,
      orgs: [
        {
          userId: id(5),
          users: [
            { userId: id(3), permissions: ['read'] },
            { userId: id(4), permissions: ['none'] },
            { userId: id(5), permissions: ['read', 'write'] },
          ],
        },
      ],
    });
    const cohort = await resolveBulkAbuseCohort(
      { kind: 'users', userIds: users.map(user => user.id) },
      ACTOR_ID,
      adapters
    );

    expect(cohort.included.map(user => user.id)).toEqual([id(1), id(4)]);
    expect(Object.fromEntries(cohort.excluded.map(entry => [entry.userId, entry.reason]))).toEqual({
      [id(2)]: 'org_member',
      [id(3)]: 'org_member',
      [id(5)]: 'org_owner',
    });
  });

  it('reports unknown user ids as not found', async () => {
    const { adapters } = cohortAdapters({ users: [makeUser(1)] });
    const cohort = await resolveBulkAbuseCohort({ kind: 'users', userIds: [id(1), id(9)] }, ACTOR_ID, adapters);
    expect(cohort.excluded).toEqual([{ userId: id(9), email: null, reason: 'not_found' }]);
  });

  it('looks up selected users without soft-deleted accounts', async () => {
    const { adapters } = cohortAdapters({ users: [makeUser(1)] });
    await resolveBulkAbuseCohort({ kind: 'users', userIds: [id(1)] }, ACTOR_ID, adapters);
    expect(adapters.db.users.find).toHaveBeenCalledWith({ _id: { $in: [id(1)] }, deletedAt: null });
  });

  it('caps a domain batch and hands back a cursor that continues after the last scanned user', async () => {
    const users = Array.from({ length: MAX_BULK_ABUSE_BATCH + 5 }, (_, i) => makeUser(i + 1));
    const { adapters } = cohortAdapters({ users });

    const first = await resolveBulkAbuseCohort({ kind: 'domain', domain: 'kashre.com' }, ACTOR_ID, adapters);
    expect(first.included).toHaveLength(MAX_BULK_ABUSE_BATCH);
    expect(first).toMatchObject({ hasMore: true, nextAfterUserId: id(MAX_BULK_ABUSE_BATCH) });

    const next = await resolveBulkAbuseCohort(
      { kind: 'domain', domain: 'kashre.com', afterUserId: first.nextAfterUserId ?? undefined },
      ACTOR_ID,
      adapters
    );
    expect(next.included).toHaveLength(5);
    expect(next).toMatchObject({ hasMore: false, nextAfterUserId: null });
  });

  it('advances the cursor past a scanned row that the domain re-check drops', async () => {
    const users = Array.from({ length: MAX_BULK_ABUSE_BATCH + 1 }, (_, i) =>
      i + 1 === MAX_BULK_ABUSE_BATCH ? makeUser(i + 1, { email: 'x@notkashre.com' }) : makeUser(i + 1)
    );
    const { adapters } = cohortAdapters({ users });

    const cohort = await resolveBulkAbuseCohort({ kind: 'domain', domain: 'kashre.com' }, ACTOR_ID, adapters);
    expect(cohort.included).toHaveLength(MAX_BULK_ABUSE_BATCH - 1);
    expect(cohort.nextAfterUserId).toBe(id(MAX_BULK_ABUSE_BATCH));
  });

  it('bounds a domain cohort by the preview-time id, so later signups do not change it', async () => {
    const bound = userIdUpperBound(new Date('2026-01-01T00:00:00Z'));
    const lateSignup = {
      ...makeUser(99),
      id: userIdUpperBound(new Date('2026-01-02T00:00:00Z')).slice(0, 8) + '0'.repeat(16),
    };
    const { adapters, find } = cohortAdapters({ users: [makeUser(1), lateSignup] });

    const cohort = await resolveBulkAbuseCohort({ kind: 'domain', domain: 'kashre.com' }, ACTOR_ID, adapters, {
      upToUserId: bound,
    });

    expect(cohort.included.map(user => user.id)).toEqual([id(1)]);
    expect(cohort.upToUserId).toBe(bound);
    expect(find.mock.calls[0][0]._id).toEqual({ $lte: bound });
  });

  it('defaults the bound to now and reports none for an explicit user list', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T12:00:00Z'), toFake: ['Date'] });
    const { adapters } = cohortAdapters({ users: [makeUser(1)] });
    const domainCohort = await resolveBulkAbuseCohort({ kind: 'domain', domain: 'kashre.com' }, ACTOR_ID, adapters);
    expect(domainCohort.upToUserId).toBe(userIdUpperBound(new Date('2026-10-23T12:00:00Z')));
    vi.useRealTimers();

    const usersCohort = await resolveBulkAbuseCohort({ kind: 'users', userIds: [id(1)] }, ACTOR_ID, adapters);
    expect(usersCohort.upToUserId).toBeNull();
  });
});

describe('userIdUpperBound', () => {
  it('sorts after every id minted up to that second and before the next second', () => {
    const at = new Date('2026-10-23T12:00:00Z');
    const seconds = Math.floor(at.getTime() / 1000).toString(16);
    expect(userIdUpperBound(at)).toBe(`${seconds}ffffffffffffffff`);
    expect(`${seconds}0123456789abcdef` <= userIdUpperBound(at)).toBe(true);
    expect(userIdUpperBound(new Date(at.getTime() + 1000)) > userIdUpperBound(at)).toBe(true);
  });
});

describe('bulkAbuseFingerprint', () => {
  const target = { kind: 'users' as const, userIds: [id(2), id(1)] };

  it('ignores ordering', () => {
    expect(bulkAbuseFingerprint(target, ALL_ACTIONS, [id(1), id(2)])).toBe(
      bulkAbuseFingerprint({ kind: 'users', userIds: [id(1), id(2)] }, ALL_ACTIONS, [id(2), id(1)])
    );
  });

  it('changes when the included users, the actions or the target change', () => {
    const base = bulkAbuseFingerprint(target, ALL_ACTIONS, [id(1), id(2)]);
    expect(bulkAbuseFingerprint(target, ALL_ACTIONS, [id(1)])).not.toBe(base);
    expect(bulkAbuseFingerprint(target, ONLY('ban'), [id(1), id(2)])).not.toBe(base);
    expect(bulkAbuseFingerprint({ kind: 'domain', domain: 'kashre.com' }, ALL_ACTIONS, [id(1), id(2)])).not.toBe(base);
  });
});

describe('clawbackAmount', () => {
  it('takes the smaller of the balance and the grant, never below zero', () => {
    expect(clawbackAmount(100, 50)).toBe(50);
    expect(clawbackAmount(20, 50)).toBe(20);
    expect(clawbackAmount(-10, 50)).toBe(0);
    expect(clawbackAmount(100, 0)).toBe(0);
  });
});

describe('previewBulkAbuseCounts', () => {
  it('totals keys, banned users and unspent grant credits, skipping users already clawed back', async () => {
    const users = [makeUser(1, { currentCredits: 30 }), makeUser(2, { isBanned: true }), makeUser(3)];
    const credits: CreditRow[] = [
      { ownerId: id(1), credits: 50, type: 'generic_add', transactionId: `verify-grant:${id(1)}` },
      { ownerId: id(2), credits: 50, type: 'generic_add', transactionId: `otc-register-grant:${id(2)}` },
      { ownerId: id(3), credits: 50, type: 'generic_add', transactionId: `verify-grant:${id(3)}` },
      { ownerId: id(3), credits: 50, type: 'generic_deduct', reason: 'abuse_clawback' },
    ];
    const count = vi.fn(async () => 4);
    const counts = await previewBulkAbuseCounts(users, {
      db: {
        userApiKeys: { count },
        creditTransactions: {
          find: async (filter: Record<string, unknown>) =>
            credits.filter(row => matches(row as unknown as Record<string, unknown>, filter)),
        } as unknown as BulkAbuseExecuteAdapters['db']['creditTransactions'],
      },
    });

    expect(counts).toMatchObject({ activeApiKeyCount: 4, alreadyBannedCount: 1, clawbackCredits: 30 + 50 });
    expect(counts.sample.map(user => user.id)).toEqual([id(1), id(2), id(3)]);
    // The same keys execute's deactivateAllByUserId disables: anything not already disabled.
    expect(count).toHaveBeenCalledWith({ userId: { $in: [id(1), id(2), id(3)] }, status: { $ne: 'disabled' } });
  });
});

function executeAdapters(users: IUser[], credits: CreditRow[], liveKeys: Record<string, number> = {}) {
  const store = new Map(users.map(user => [user.id, { ...user }]));
  const audit = vi.fn(async () => null);
  const createTransaction = vi.fn(async (_type: string, data: CreditRow) => {
    credits.push({ ...data, type: 'generic_deduct' });
    return { id: `tx-${data.ownerId}` };
  });
  const adapters: BulkAbuseExecuteAdapters = {
    db: {
      users: {
        findById: vi.fn(async (userId: string) => store.get(userId) ?? null),
        update: vi.fn(async (data: Partial<IUser>) => {
          const current = store.get(data.id as string);
          if (!current) return null;
          Object.assign(current, data);
          return current;
        }),
        incrementTokenVersion: vi.fn(async () => 2),
        incrementCredits: vi.fn(async (ownerId: string, delta: number) => {
          const current = store.get(ownerId);
          if (current) current.currentCredits += delta;
          return current;
        }),
      } as unknown as BulkAbuseExecuteAdapters['db']['users'],
      userApiKeys: {
        count: vi.fn(async (filter: Record<string, unknown>) => liveKeys[filter.userId as string] ?? 0),
        deactivateAllByUserId: vi.fn(async () => undefined),
      },
      authSessions: { revokeAllByUserId: vi.fn(async () => 1) },
      realtimeConnections: { endConnections: vi.fn(async () => ({ connectionIds: [] })) },
      trustedDevices: { revokeAllForUser: vi.fn(async () => 0) },
      creditTransactions: {
        find: vi.fn(async (filter: Record<string, unknown>) =>
          credits.filter(row => matches(row as unknown as Record<string, unknown>, filter))
        ),
        createTransaction,
      } as unknown as BulkAbuseExecuteAdapters['db']['creditTransactions'],
    },
    withTransaction: async fn => fn(),
    audit,
  };
  return { adapters, store, audit, createTransaction };
}

describe('executeBulkAbuse', () => {
  it('ends the realtime connections a revoked key opened, even without a ban', async () => {
    const user = makeUser(1);
    const { adapters } = executeAdapters([user], [], { [id(1)]: 1 });

    await executeBulkAbuse([user], ONLY('revokeApiKeys'), ACTOR_ID, adapters);

    expect(adapters.db.realtimeConnections.endConnections).toHaveBeenCalledTimes(1);
  });

  it('treats ban as implying an API key revoke, so unbanning never re-enables old keys', async () => {
    const user = makeUser(1);
    const { adapters, audit } = executeAdapters([user], [], { [id(1)]: 2 });

    const [result] = await executeBulkAbuse([user], ONLY('ban'), ACTOR_ID, adapters);

    expect(result.steps).toMatchObject({ ban: 'applied', revokeApiKeys: 'applied' });
    expect(result.revokedApiKeys).toBe(2);
    expect(adapters.db.userApiKeys.deactivateAllByUserId).toHaveBeenCalledWith(id(1));
    expect(audit.mock.calls.map(([entry]) => (entry as { action: string }).action)).toEqual([
      'abuse.bulk.ban',
      'abuse.bulk.revoke_keys',
    ]);
  });

  it('still bumps tokenVersion but skips the audit row and sockets when nothing was left to revoke', async () => {
    const user = makeUser(1);
    const { adapters, audit } = executeAdapters([user], []);
    await executeBulkAbuse([user], ONLY('revokeSessions'), ACTOR_ID, adapters);
    vi.mocked(adapters.db.authSessions.revokeAllByUserId).mockResolvedValue(0);
    vi.mocked(audit).mockClear();
    vi.mocked(adapters.db.users.incrementTokenVersion).mockClear();
    vi.mocked(adapters.db.realtimeConnections.endConnections).mockClear();

    const [rerun] = await executeBulkAbuse([user], ONLY('revokeSessions'), ACTOR_ID, adapters);

    expect(rerun.steps.revokeSessions).toBe('skipped');
    expect(audit).not.toHaveBeenCalled();
    expect(adapters.db.users.incrementTokenVersion).toHaveBeenCalledWith(id(1));
    expect(adapters.db.realtimeConnections.endConnections).not.toHaveBeenCalled();
  });

  it('bumps tokenVersion for a user with no sessions so legacy JWTs stop working', async () => {
    const user = makeUser(1);
    const { adapters, audit } = executeAdapters([user], []);
    vi.mocked(adapters.db.authSessions.revokeAllByUserId).mockResolvedValue(0);

    const [result] = await executeBulkAbuse([user], ONLY('revokeSessions'), ACTOR_ID, adapters);

    expect(result.steps.revokeSessions).toBe('skipped');
    expect(adapters.db.users.incrementTokenVersion).toHaveBeenCalledWith(id(1));
    expect(audit).not.toHaveBeenCalled();
  });

  it('ends session sockets after the commit when sessions were revoked', async () => {
    const user = makeUser(1);
    const { adapters } = executeAdapters([user], []);

    await executeBulkAbuse([user], ONLY('revokeSessions'), ACTOR_ID, adapters);

    expect(adapters.db.users.incrementTokenVersion).toHaveBeenCalledWith(id(1));
    expect(adapters.db.realtimeConnections.endConnections).toHaveBeenCalledWith({ userId: id(1), sessionsOnly: true });
  });

  it('leaves realtime connections alone when nothing was revoked or banned', async () => {
    const user = makeUser(1);
    const { adapters } = executeAdapters([user], [], {});

    await executeBulkAbuse([user], ONLY('revokeApiKeys'), ACTOR_ID, adapters);

    expect(adapters.db.realtimeConnections.endConnections).not.toHaveBeenCalled();
  });

  it('bans, revokes keys and sessions and claws back the unspent grant, auditing each step', async () => {
    const user = makeUser(1, { currentCredits: 80 });
    const { adapters, store, audit } = executeAdapters(
      [user],
      [{ ownerId: id(1), credits: 50, type: 'generic_add', transactionId: `verify-grant:${id(1)}` }],
      { [id(1)]: 2 }
    );

    const [result] = await executeBulkAbuse([user], ALL_ACTIONS, ACTOR_ID, adapters);

    expect(result).toMatchObject({
      status: 'succeeded',
      steps: { ban: 'applied', revokeApiKeys: 'applied', revokeSessions: 'applied', clawbackFreeCredits: 'applied' },
      revokedApiKeys: 2,
      clawedBackCredits: 50,
    });
    expect(store.get(id(1))).toMatchObject({ isBanned: true, currentCredits: 30 });
    expect(adapters.db.userApiKeys.deactivateAllByUserId).toHaveBeenCalledWith(id(1));
    expect(adapters.db.authSessions.revokeAllByUserId).toHaveBeenCalledWith(id(1));
    expect(adapters.db.trustedDevices.revokeAllForUser).toHaveBeenCalledWith(id(1));
    expect(audit.mock.calls.map(([entry]) => (entry as { action: string }).action)).toEqual([
      'abuse.bulk.ban',
      'abuse.bulk.revoke_keys',
      'abuse.bulk.revoke_sessions',
      'abuse.bulk.clawback',
    ]);
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ credits: -50 }),
        related: { creditTransactionId: 'tx-' + id(1) },
      })
    );
  });

  it('runs only the selected actions', async () => {
    const user = makeUser(1);
    const { adapters, store } = executeAdapters([user], [], { [id(1)]: 1 });

    const [result] = await executeBulkAbuse([user], ONLY('revokeApiKeys'), ACTOR_ID, adapters);

    expect(result.steps).toEqual({
      ban: 'not_requested',
      revokeApiKeys: 'applied',
      revokeSessions: 'not_requested',
      clawbackFreeCredits: 'not_requested',
    });
    expect(store.get(id(1))?.isBanned).toBe(false);
    expect(adapters.db.authSessions.revokeAllByUserId).not.toHaveBeenCalled();
  });

  it('is idempotent: a re-run skips the ban, the keys and the clawback', async () => {
    const user = makeUser(1, { currentCredits: 80 });
    const credits: CreditRow[] = [
      { ownerId: id(1), credits: 50, type: 'generic_add', transactionId: `verify-grant:${id(1)}` },
    ];
    const keys = { [id(1)]: 1 };
    const { adapters, store, createTransaction } = executeAdapters([user], credits, keys);

    await executeBulkAbuse([user], ALL_ACTIONS, ACTOR_ID, adapters);
    keys[id(1)] = 0;
    const [rerun] = await executeBulkAbuse([user], ALL_ACTIONS, ACTOR_ID, adapters);

    expect(rerun.steps).toMatchObject({ ban: 'skipped', revokeApiKeys: 'skipped', clawbackFreeCredits: 'skipped' });
    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(store.get(id(1))?.currentCredits).toBe(30);
  });

  it('never claws back more than the balance, and nothing from a user with no signup grant', async () => {
    const low = makeUser(1, { currentCredits: 10 });
    const ungranted = makeUser(2, { currentCredits: 500 });
    const { adapters, store } = executeAdapters(
      [low, ungranted],
      [{ ownerId: id(1), credits: 50, type: 'generic_add', transactionId: `verify-grant:${id(1)}` }]
    );

    const results = await executeBulkAbuse([low, ungranted], ONLY('clawbackFreeCredits'), ACTOR_ID, adapters);

    expect(results.map(result => result.clawedBackCredits)).toEqual([10, 0]);
    expect(store.get(id(1))?.currentCredits).toBe(0);
    expect(store.get(id(2))?.currentCredits).toBe(500);
  });

  it('reports a failed user and carries on with the rest', async () => {
    const users = [makeUser(1), makeUser(2)];
    const { adapters, store } = executeAdapters(users, []);
    const update = adapters.db.users.update as ReturnType<typeof vi.fn>;
    const original = update.getMockImplementation();
    update.mockImplementation(async (data: Partial<IUser>) => {
      if (data.id === id(1)) throw new Error('write conflict');
      return original?.(data);
    });

    const results = await executeBulkAbuse(users, ONLY('ban'), ACTOR_ID, adapters);

    expect(results.map(result => result.status)).toEqual(['failed', 'succeeded']);
    expect(results[0].error).toBe('write conflict');
    expect(store.get(id(2))?.isBanned).toBe(true);
  });
});
