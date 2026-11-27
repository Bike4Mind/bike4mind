import type { ISpendFreeze } from '@bike4mind/common';
import { recordAdminAction } from '../adminAuditService';
import { requireReason, toAuditTarget } from './auditTarget';
import type { SpendFreezeAdapters, SpendFreezeChangeInput } from './types';

const isDuplicateKeyError = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 11000;

/**
 * Freezes new metered spend for a scope. Idempotent: an already-active freeze is returned with
 * `created: false` and no audit entry. The audit write is strict, so its failure rejects the call.
 */
export const freezeSpend = async (
  input: SpendFreezeChangeInput,
  adapters: SpendFreezeAdapters
): Promise<{ freeze: ISpendFreeze; created: boolean }> => {
  const reason = requireReason(input.reason);
  const { scope, actor, audit, session } = input;
  const { spendFreezes } = adapters.db;

  const existing = await spendFreezes.findActive(scope);
  if (existing) return { freeze: existing, created: false };

  let freeze: ISpendFreeze;
  try {
    freeze = await spendFreezes.createActive(
      { ...scope, reason, actor, frozenAt: input.now ?? new Date() },
      { session }
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    // A concurrent freeze won the race and audits it. Outside a transaction this re-read returns
    // the winner. Inside one (the admin routes' `withTransaction`) the server has aborted the
    // transaction, so this read rejects with a transient error and `withTransaction` retries the
    // callback, whose first `findActive` returns the committed winner.
    const winner = await spendFreezes.findActive(scope);
    if (!winner) throw error;
    return { freeze: winner, created: false };
  }

  await recordAdminAction(
    {
      action: 'spend.freeze.applied',
      actor: audit.actor,
      target: toAuditTarget(scope),
      summary: `Froze spend for ${scope.scopeType} ${scope.scopeId}`,
      context: audit.context,
      reason,
      changes: [{ field: 'spendFrozen', before: false, after: true }],
      details: { freezeId: freeze.id, actorKind: actor.kind },
      occurredAt: input.now,
    },
    { db: adapters.db, logger: adapters.logger }
  );

  return { freeze, created: true };
};
