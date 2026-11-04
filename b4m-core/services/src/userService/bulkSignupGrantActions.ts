import type { IUserRepository } from '@bike4mind/common';
import { MAX_BULK_RELEASE } from './heldSignupGrants';
import {
  classifySignupGrantAction,
  type SignupGrantAdminAction,
  type SignupGrantNoopReason,
} from './signupGrantActionClassifier';
import { blockSignupGrant, unblockSignupGrant, type SignupGrantBlockAdapters } from './signupGrantAdminActions';

export const MAX_BULK_SIGNUP_GRANT_ACTION = MAX_BULK_RELEASE;

export type BulkSignupGrantRow = {
  userId: string;
  outcome: 'applied' | 'would_apply' | 'noop' | 'failed';
  reason?: SignupGrantNoopReason;
  rewardsAffected?: number;
};

export type BulkSignupGrantResult = {
  dryRun: boolean;
  results: BulkSignupGrantRow[];
  /** The accounts this run changed; sending them to the opposite bulk action reverses the run. */
  undoUserIds: string[];
};

const dedupe = (userIds: string[]) => [...new Set(userIds)].slice(0, MAX_BULK_SIGNUP_GRANT_ACTION);

/**
 * Reports, without writing anything, what `action` would do to each account. It uses the same classifier the
 * real actions gate on, so the preview names the same no-op reasons the run would return.
 */
export async function previewSignupGrantAction(
  input: { action: SignupGrantAdminAction; userIds: string[]; dripCap?: number },
  adapters: { users: Pick<IUserRepository, 'findById'> }
): Promise<BulkSignupGrantResult> {
  const results: BulkSignupGrantRow[] = [];
  for (const userId of dedupe(input.userIds)) {
    const verdict = classifySignupGrantAction(await adapters.users.findById(userId), input.action, input.dripCap);
    results.push(
      verdict.eligible ? { userId, outcome: 'would_apply' } : { userId, outcome: 'noop', reason: verdict.reason }
    );
  }
  return { dryRun: true, results, undoUserIds: [] };
}

export type BulkSignupGrantBlockAdapters = Omit<SignupGrantBlockAdapters, 'audit'> & {
  /** Builds the per-account audit write, run in the same transaction as that account's flag change. */
  auditFor?: (userId: string) => () => Promise<void>;
  logger: { error: (message: string, ...args: unknown[]) => void };
};

/**
 * Blocks or unblocks each account in turn through the per-account action, so a bulk run has the same gates,
 * audit write and no-op reasons as a single one. One account failing does not stop the rest: it is reported as
 * failed and can be retried, since a repeat on an applied account is a no-op.
 */
export async function bulkSetSignupGrantBlock(
  input: { action: 'block' | 'unblock'; userIds: string[] },
  adapters: BulkSignupGrantBlockAdapters
): Promise<BulkSignupGrantResult> {
  const act = input.action === 'block' ? blockSignupGrant : unblockSignupGrant;
  const results: BulkSignupGrantRow[] = [];
  for (const userId of dedupe(input.userIds)) {
    try {
      const result = await act(userId, { ...adapters, audit: adapters.auditFor?.(userId) });
      results.push(
        result.outcome === 'applied'
          ? { userId, outcome: 'applied', rewardsAffected: result.rewardsAffected }
          : { userId, outcome: 'noop', reason: result.reason, rewardsAffected: result.rewardsAffected }
      );
    } catch (error) {
      adapters.logger.error(`Bulk signup grant ${input.action} failed for user ${userId}`, error);
      results.push({ userId, outcome: 'failed' });
    }
  }
  return {
    dryRun: false,
    results,
    undoUserIds: results.filter(row => row.outcome === 'applied').map(row => row.userId),
  };
}
