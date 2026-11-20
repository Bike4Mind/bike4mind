import { describe, expect, it, vi } from 'vitest';
import type { SignupGrant } from '@bike4mind/common';
import { bulkSetSignupGrantBlock, previewSignupGrantAction } from './bulkSignupGrantActions';

vi.mock('@bike4mind/db-core', () => ({ withTransaction: <T>(fn: () => Promise<T>) => fn() }));

const grant = (blocked = false): SignupGrant => ({
  stage: 'signup',
  signupCredits: 10,
  unlockCredits: 40,
  creditsReleased: 10,
  nextCondition: 'verification',
  ...(blocked ? { blocked: { at: new Date('2026-11-04T00:00:00.000Z') } } : {}),
});

type Doc = { id: string; signupGrant?: SignupGrant };

const build = (docs: Doc[]) => {
  const store = new Map(docs.map(doc => [doc.id, doc]));
  const users = {
    findById: vi.fn(async (id: string) => store.get(id) ?? null),
    update: vi.fn(async (patch: Doc) => {
      store.set(patch.id, { ...store.get(patch.id), ...patch });
      return store.get(patch.id);
    }),
    addTagsToUser: vi.fn(),
  };
  const heldRewards = { pauseForUser: vi.fn(async () => 1), resumeForUser: vi.fn(async () => 1) };
  const logger = { error: vi.fn() };
  const audit = vi.fn();
  // Test double: the service only calls the repository methods stubbed above.
  const adapters = { users, heldRewards, logger, auditFor: () => audit } as unknown as Parameters<
    typeof bulkSetSignupGrantBlock
  >[1];
  return { store, users, heldRewards, logger, audit, adapters };
};

describe('previewSignupGrantAction', () => {
  it('reports eligible and refused accounts without writing', async () => {
    const { users } = build([{ id: 'a', signupGrant: grant() }, { id: 'b', signupGrant: grant(true) }, { id: 'c' }]);
    const preview = await previewSignupGrantAction(
      { action: 'block', userIds: ['a', 'b', 'c', 'missing', 'a'] },
      { users }
    );

    expect(preview).toEqual({
      dryRun: true,
      undoUserIds: [],
      results: [
        { userId: 'a', outcome: 'would_apply' },
        { userId: 'b', outcome: 'noop', reason: 'already_blocked' },
        { userId: 'c', outcome: 'noop', reason: 'no_grant' },
        { userId: 'missing', outcome: 'noop', reason: 'no_grant' },
      ],
    });
    expect(users.update).not.toHaveBeenCalled();
  });
});

describe('bulkSetSignupGrantBlock', () => {
  it('blocks each eligible account, audits it, and lists the changed accounts for undo', async () => {
    const { store, audit, heldRewards, adapters } = build([
      { id: 'a', signupGrant: grant() },
      { id: 'b', signupGrant: grant(true) },
    ]);
    const result = await bulkSetSignupGrantBlock({ action: 'block', userIds: ['a', 'b'] }, adapters);

    expect(result.dryRun).toBe(false);
    expect(result.results).toEqual([
      { userId: 'a', outcome: 'applied', rewardsAffected: 1 },
      { userId: 'b', outcome: 'noop', reason: 'already_blocked', rewardsAffected: 1 },
    ]);
    expect(result.undoUserIds).toEqual(['a']);
    expect(store.get('a')?.signupGrant?.blocked).toBeDefined();
    expect(audit).toHaveBeenCalledOnce();
    expect(heldRewards.pauseForUser).toHaveBeenCalledTimes(2);
  });

  it('reverses a run when its undo ids go through unblock', async () => {
    const { store, adapters } = build([{ id: 'a', signupGrant: grant() }]);
    const blocked = await bulkSetSignupGrantBlock({ action: 'block', userIds: ['a'] }, adapters);
    const undone = await bulkSetSignupGrantBlock({ action: 'unblock', userIds: blocked.undoUserIds }, adapters);

    expect(undone.results[0]).toMatchObject({ userId: 'a', outcome: 'applied' });
    expect(store.get('a')?.signupGrant?.blocked).toBeUndefined();
  });

  it('reports a failing account and carries on with the rest', async () => {
    const { users, logger, adapters } = build([
      { id: 'a', signupGrant: grant() },
      { id: 'b', signupGrant: grant() },
    ]);
    users.update.mockRejectedValueOnce(new Error('db down'));
    const result = await bulkSetSignupGrantBlock({ action: 'block', userIds: ['a', 'b'] }, adapters);

    expect(result.results.map(row => row.outcome)).toEqual(['failed', 'applied']);
    expect(result.undoUserIds).toEqual(['b']);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('caps a run at the bulk limit', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const { adapters } = build([]);
    const result = await bulkSetSignupGrantBlock({ action: 'block', userIds: ids }, adapters);
    expect(result.results).toHaveLength(100);
  });
});
