import { describe, expect, it, vi } from 'vitest';
import { applyActionToUser, executeAdminUsersBulk, type ApplyDeps, type ApplyContext } from './execute';
import { cohortHashOf, type BulkUser } from './resolve';

const user: BulkUser = {
  id: 'b'.repeat(24),
  name: null,
  email: null,
  username: null,
  isAdmin: false,
  isBanned: false,
  isModerated: false,
  tags: [],
  currentCredits: 0,
  disputePending: false,
  moderationStatus: null,
};

const context: ApplyContext = {
  action: { type: 'adjustCredits', mode: 'set', amount: 1000 },
  actorId: 'a'.repeat(24),
  reason: 'Correct the account balance',
  batchId: 'batch',
  cancelDeadline: Date.now() + 60_000,
  creditBalances: { [user.id]: 1000 },
};

function dependencies(): ApplyDeps {
  return {
    db: {
      findUser: vi.fn(async () => user),
      setFlag: vi.fn(),
      addTag: vi.fn(),
      removeTag: vi.fn(),
      revokeLiveApiKeys: vi.fn(),
      reactivateApiKeys: vi.fn(),
      adjustCredits: vi.fn(async () => ({})),
    },
    store: {
      claimDedup: vi.fn(),
      casUpdateDedup: vi.fn(async () => true),
      casDeleteDedup: vi.fn(),
      createOrUpdate: vi.fn(),
      findByKey: vi.fn(),
      readDedup: vi.fn(),
      deleteByKeyAndReturn: vi.fn(),
    },
    withTransaction: async callback => callback(),
    audit: vi.fn(),
    endRealtimeConnections: vi.fn(),
    cancelSubscriptions: vi.fn(),
  };
}

describe('bulk set approval allowance', () => {
  it('refuses a balance that changed after the approval gate before writing credits', async () => {
    const deps = dependencies();
    vi.mocked(deps.store.claimDedup).mockResolvedValue({ claimed: true });
    const result = await executeAdminUsersBulk(
      {
        target: { kind: 'ids', userIds: [user.id] },
        action: context.action,
        reason: context.reason,
        idempotencyKey: 'credit-gate-test',
        expectedCount: 1,
        cohortHash: cohortHashOf([user]),
      },
      { id: context.actorId, selfIds: [context.actorId], creditBalances: context.creditBalances },
      {
        ...deps,
        findUsersByIds: async () => [user],
        openFilterPages: vi.fn(),
        auditSummary: vi.fn(async () => undefined),
        blockEmailDomains: vi.fn(),
      }
    );
    expect(result.applied).toBe(0);
    expect(result.failed).toEqual([
      { userId: user.id, error: 'The credit balance changed; review this action again.' },
    ]);
    expect(deps.db.adjustCredits).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('allows an unchanged balance and preserves the set action', async () => {
    const deps = dependencies();
    const expected = { ...context, creditBalances: { [user.id]: 0 } };
    await applyActionToUser(user.id, expected, deps, vi.fn());
    expect(deps.db.adjustCredits).toHaveBeenCalledWith(expect.objectContaining({ delta: 1000, previousBalance: 0 }));
  });
});
