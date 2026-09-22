import type {
  IDataLakeDocument,
  ILakeMembershipChangeEventRepository,
  LakeMembershipChangeAction,
  LakeMembershipChangeOrigin,
} from '@bike4mind/common';
import type { ManageActor } from './manageRule';
import type { LakeConfigAuditLogger } from './resolveLakeConfigAuditRetention';

/** Reuses the config-audit logger shape (rather than declaring a near-duplicate) so a single
 * `{ db, logger }` can satisfy both audit adapters' interfaces without a cast at every call site
 * that wires both. */
export type LakeMembershipAuditLogger = LakeConfigAuditLogger;

/**
 * The audit half of a membership-write door's adapters. Optional, mirroring
 * `LakeConfigAuditAdapters`: a caller with no reason to wire an audit trail (a script, a test)
 * simply gets no recorded event rather than a compile error.
 */
export interface LakeMembershipAuditAdapters {
  db: {
    lakeMembershipChangeEvents?: Pick<ILakeMembershipChangeEventRepository, 'record'>;
  };
  logger?: LakeMembershipAuditLogger;
}

export interface RecordLakeMembershipChangeParams {
  actor: ManageActor;
  lake: Pick<IDataLakeDocument, 'id' | 'organizationId'>;
  fabFileId: string;
  action: LakeMembershipChangeAction;
  /** Who drove the write - see `LakeMembershipChangeOrigin`'s own doc comment for why this must
   * come from the call site rather than being inferred here. */
  origin: LakeMembershipChangeOrigin;
}

/**
 * Record one membership-change event, BEST-EFFORT: any failure is logged and swallowed, never
 * thrown - the identical inversion `recordLakeConfigChange` documents and for the same reason. By
 * the time this runs the membership write has already landed (the FabFile's tags are the source
 * of truth), so throwing here would report a failed join/leave that in fact succeeded.
 */
export async function recordLakeMembershipChange(
  { actor, lake, fabFileId, action, origin }: RecordLakeMembershipChangeParams,
  { db, logger }: LakeMembershipAuditAdapters
): Promise<void> {
  const events = db.lakeMembershipChangeEvents;
  if (!events) return;

  const logAuditLoss = (msg: string, meta: Record<string, unknown>) => {
    if (logger?.error) return logger.error(msg, meta);
    if (logger?.warn) return logger.warn(msg, meta);
    return console.error(msg, meta);
  };

  try {
    await events.record({
      // Read as a PAIR, never field by field - the same rule `recordLakeConfigChange` states for
      // its identical union: mixing a resolved kind with a fallback id would record `apiKey`
      // against the human's id.
      ...(actor.auditPrincipal
        ? {
            principalKind: actor.auditPrincipal.principalKind,
            principalId: actor.auditPrincipal.principalId,
            onBehalfOfUserId: actor.auditPrincipal.onBehalfOfUserId,
          }
        : {
            principalKind: actor.userId ? ('user' as const) : ('system' as const),
            principalId: actor.userId || 'system',
          }),
      organizationId: lake.organizationId || undefined,
      dataLakeId: lake.id,
      fabFileId,
      action,
      origin,
    });
  } catch (err) {
    logAuditLoss('[dataLakes] lake membership changed but the audit event did not persist', {
      dataLakeId: lake.id,
      fabFileId,
      action,
      err,
    });
  }
}
