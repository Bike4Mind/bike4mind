import { describe, expect, it, vi } from 'vitest';
import { executeAdminUsersBulk, type CreditGrantHold, type ExecuteDeps } from './execute';
import { cohortHashOf, type BulkUser } from './resolve';
import type { AdminUsersBulkAction } from '../../app/utils/adminUsersBulk';

const bulkUser = (id: string, currentCredits = 0): BulkUser => ({
  id,
  name: null,
  email: null,
  username: null,
  isAdmin: false,
  isBanned: false,
  isModerated: false,
  tags: [],
  currentCredits,
  disputePending: false,
  moderationStatus: null,
});

const UNDER = bulkUser('b'.repeat(24));
const OVER = bulkUser('c'.repeat(24));
const ACTOR = 'a'.repeat(24);
const REFUSAL = 'This user has received 200,000 admin-granted credits in the last 24 hours.';

function harness(users: BulkUser[], balances: Record<string, number> = {}) {
  const fresh = new Map(
    users.map(user => [user.id, { ...user, currentCredits: balances[user.id] ?? user.currentCredits }])
  );
  const release = vi.fn(async () => undefined);
  const capCreditGrant = vi.fn(async (user: BulkUser): Promise<CreditGrantHold> =>
    user.id === OVER.id ? { allowed: false, message: REFUSAL } : { allowed: true, release }
  );
  const deps: ExecuteDeps = {
    findUsersByIds: async () => users,
    openFilterPages: vi.fn(),
    db: {
      findUser: vi.fn(async (id: string) => fresh.get(id) ?? null),
      setFlag: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      revokeLiveApiKeys: vi.fn(async () => []),
      reactivateApiKeys: vi.fn(),
      adjustCredits: vi.fn(async () => ({})),
    },
    store: {
      claimDedup: vi.fn(async () => ({ claimed: true })),
      casUpdateDedup: vi.fn(async () => true),
      casDeleteDedup: vi.fn(),
      createOrUpdate: vi.fn(),
      findByKey: vi.fn(),
      readDedup: vi.fn(),
      deleteByKeyAndReturn: vi.fn(),
    },
    withTransaction: async callback => callback(),
    audit: vi.fn(),
    auditSummary: vi.fn(async () => undefined),
    blockEmailDomains: vi.fn(),
    endRealtimeConnections: vi.fn(),
    cancelSubscriptions: vi.fn(),
    capCreditGrant,
  };
  const run = (action: AdminUsersBulkAction) =>
    executeAdminUsersBulk(
      {
        target: { kind: 'ids', userIds: users.map(user => user.id) },
        action,
        reason: 'Goodwill credits after the outage',
        idempotencyKey: '7b1f3c52-9a3e-4b8e-8f43-2f4a1c9d0e11',
        expectedCount: users.length,
        cohortHash: cohortHashOf(users),
      },
      { id: ACTOR, selfIds: [ACTOR] },
      deps
    );
  return { deps, run, release, capCreditGrant };
}

describe('executeAdminUsersBulk - per-recipient grant cap', () => {
  it('grants the users under the cap and fails only the refused one, with its reason', async () => {
    const { deps, run, release, capCreditGrant } = harness([UNDER, OVER]);

    const result = await run({ type: 'adjustCredits', mode: 'add', amount: 100_000 });

    expect(capCreditGrant).toHaveBeenCalledWith(UNDER, 100_000);
    expect(capCreditGrant).toHaveBeenCalledWith(OVER, 100_000);
    expect(result.applied).toBe(1);
    expect(result.committedUserIds).toEqual([UNDER.id]);
    expect(result.failed).toEqual([{ userId: OVER.id, error: REFUSAL }]);
    expect(deps.db.adjustCredits).toHaveBeenCalledTimes(1);
    expect(deps.db.adjustCredits).toHaveBeenCalledWith(expect.objectContaining({ userId: UNDER.id, delta: 100_000 }));
    expect(release).toHaveBeenCalledTimes(1);
    expect(deps.auditSummary).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ failed: [{ userId: OVER.id, error: REFUSAL }] }) })
    );
  });

  it('never consults the cap for a deduction', async () => {
    const { deps, run, capCreditGrant } = harness([bulkUser(OVER.id, 500)]);

    const result = await run({ type: 'adjustCredits', mode: 'subtract', amount: 100 });

    expect(capCreditGrant).not.toHaveBeenCalled();
    expect(result.applied).toBe(1);
    expect(deps.db.adjustCredits).toHaveBeenCalledWith(expect.objectContaining({ delta: -100 }));
  });

  it('refuses a set whose fresh balance would grant more than the cap cleared, and releases the hold', async () => {
    const user = bulkUser(UNDER.id, 900);
    const { deps, run, release } = harness([user], { [user.id]: 100 });

    const result = await run({ type: 'adjustCredits', mode: 'set', amount: 1000 });

    expect(result.failed).toEqual([
      { userId: user.id, error: 'The credit balance changed; review this action again.' },
    ]);
    expect(deps.db.adjustCredits).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a set that was no grant at the cohort read but became one', async () => {
    const user = bulkUser(UNDER.id, 2000);
    const { deps, run, capCreditGrant } = harness([user], { [user.id]: 100 });

    const result = await run({ type: 'adjustCredits', mode: 'set', amount: 1000 });

    expect(capCreditGrant).not.toHaveBeenCalled();
    expect(result.failed).toHaveLength(1);
    expect(deps.db.adjustCredits).not.toHaveBeenCalled();
  });
});
