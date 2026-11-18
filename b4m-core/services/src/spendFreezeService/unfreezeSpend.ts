import type { ISpendFreeze } from '@bike4mind/common';
import { recordAdminAction } from '../adminAuditService';
import { requireReason, toAuditTarget } from './auditTarget';
import type { SpendFreezeAdapters, SpendFreezeChangeInput } from './types';

/** Lifts the active freeze for a scope. A no-op (`lifted: false`, no audit entry) when none is active. */
export const unfreezeSpend = async (
  input: SpendFreezeChangeInput,
  adapters: SpendFreezeAdapters
): Promise<{ freeze: ISpendFreeze | null; lifted: boolean }> => {
  const reason = requireReason(input.reason);
  const { scope, actor, audit, session } = input;

  const freeze = await adapters.db.spendFreezes.liftActive(
    scope,
    { liftedBy: actor, liftReason: reason, liftedAt: input.now ?? new Date() },
    { session }
  );
  if (!freeze) return { freeze: null, lifted: false };

  await recordAdminAction(
    {
      action: 'spend.freeze.lifted',
      actor: audit.actor,
      target: toAuditTarget(scope),
      summary: `Lifted spend freeze for ${scope.scopeType} ${scope.scopeId}`,
      context: audit.context,
      reason,
      changes: [{ field: 'spendFrozen', before: true, after: false }],
      details: { freezeId: freeze.id, actorKind: actor.kind },
      occurredAt: input.now,
    },
    { db: adapters.db, logger: adapters.logger }
  );

  return { freeze, lifted: true };
};
