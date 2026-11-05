import {
  adminAuditLogRepository,
  creditTransactionRepository,
  stripeDisputeRepository,
  userRepository,
  withTransaction,
  type StripeDisputeFacts,
} from '@bike4mind/database';
import {
  CREDIT_ADD_TRANSACTION_TYPES,
  CreditHolderType,
  type AuditActor,
  type StripeDisputeItem,
  type StripeDisputeSubject,
} from '@bike4mind/common';
import { adminAuditService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { applyActionToUser } from '@server/admin/usersBulk/execute';
import { usersBulkSystemApplyDeps } from '@server/admin/usersBulk/adapters';
import {
  SUBSCRIPTION_CANCEL_GRACE_MS,
  UserUndoSnapshotSchema,
  type UserUndoSnapshot,
} from '@server/admin/usersBulk/ports';
import type { BulkUser } from '@server/admin/usersBulk/resolve';
import { revertUserSnapshot, type RevertDeps } from '@server/admin/usersBulk/undo';
import { systemAuditActor } from '@server/utils/adminAudit';

/**
 * The lifecycle of a Stripe dispute on our side (record contract in
 * b4m-core/common/src/schemas/stripeDispute.ts). The webhook records every dispute; a won one is
 * resolved by the system (the caller clears the dispute flag), a lost one on a user's payment is
 * resolved by the system and contains the account, and organization or unmatched disputes wait in the
 * admin Disputes queue. Nothing here ever clears a dispute flag.
 */

const SYSTEM_ACTOR_NAME = 'Stripe dispute';
/** Stamped on the Contain's ledger row and revoked keys, where an admin's user id would otherwise go. */
export const DISPUTE_SYSTEM_ACTOR_ID = 'system:stripe-dispute';

/** The fields of a Stripe dispute this module reads (a subset of Stripe.Dispute). */
export type StripeDisputeEvent = {
  id: string;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  created: number;
  charge: string | { id: string } | null;
  payment_intent: string | { id: string } | null;
};

const idOf = (ref: string | { id: string } | null) => (typeof ref === 'string' ? ref : (ref?.id ?? null));

export const disputeFacts = (
  dispute: StripeDisputeEvent,
  subject: StripeDisputeSubject,
  subjectId: string | null
): StripeDisputeFacts => ({
  stripeDisputeId: dispute.id,
  chargeId: idOf(dispute.charge),
  paymentIntentId: idOf(dispute.payment_intent),
  amount: dispute.amount,
  currency: dispute.currency,
  reason: dispute.reason,
  stripeStatus: dispute.status,
  subject,
  subjectId,
  // Stripe's `created` is in seconds.
  openedAt: new Date(dispute.created * 1000),
});

const auditTarget = (item: StripeDisputeItem) =>
  item.subject === 'unmatched' || !item.subjectId
    ? { kind: 'system' as const, id: item.stripeDisputeId, displayName: `Stripe dispute ${item.stripeDisputeId}` }
    : { kind: item.subject, id: item.subjectId, displayName: item.subjectId };

export const disputeAuditDetails = (item: StripeDisputeItem) => ({
  stripeDisputeId: item.stripeDisputeId,
  subject: item.subject,
  amount: item.amount,
  currency: item.currency,
  stripeStatus: item.stripeStatus,
  outcome: item.resolution?.outcome ?? null,
  contain: item.contain
    ? {
        batchId: item.contain.batchId,
        suspended: item.contain.suspended,
        creditDelta: item.contain.creditDelta,
        apiKeysRevoked: item.contain.apiKeysRevoked,
      }
    : null,
});

/** The `billing.dispute.resolved` entry for a resolution the system made. Best-effort: never throws. */
async function auditSystemResolution(item: StripeDisputeItem, summary: string, logger: Logger): Promise<void> {
  const actor: AuditActor = systemAuditActor(SYSTEM_ACTOR_NAME);
  try {
    await adminAuditService.recordAdminAction(
      {
        action: 'billing.dispute.resolved',
        actor,
        target: auditTarget(item),
        summary,
        reason: `Stripe closed dispute ${item.stripeDisputeId} as ${item.stripeStatus}`,
        context: { source: 'worker' },
        details: disputeAuditDetails(item),
      },
      { db: { adminAuditLog: adminAuditLogRepository }, logger }
    );
  } catch (error) {
    logger.error(`Audit entry failed for resolved dispute ${item.stripeDisputeId}`, error);
  }
}

/** Resolves a won dispute's record. The caller clears a user's dispute flag; that is the only clear. */
export async function resolveWonDispute(stripeDisputeId: string, logger: Logger): Promise<void> {
  const item = await stripeDisputeRepository.resolveBySystem(stripeDisputeId, 'won');
  if (item) await auditSystemResolution(item, 'resolved a won Stripe dispute', logger);
}

export type LostDisputeOutcome =
  | { status: 'contained'; item: StripeDisputeItem }
  /** Resolved without a Contain: the account was already contained, or is an admin's (never automated). */
  | { status: 'resolved_without_contain'; item: StripeDisputeItem }
  | { status: 'already_resolved' };

class DisputeAlreadyResolved extends Error {}

/**
 * Sets the dispute flag, which charge.dispute.created normally set already. A close whose open event
 * never arrived would otherwise leave a contained account that an undo fully unblocks. Only after
 * this delivery resolved the dispute, so a redelivery never re-sets a flag a won dispute cleared.
 */
const keepBlocked = (userId: string) => userRepository.update({ id: userId, disputePending: true });

const containOf = (snapshot: UserUndoSnapshot, batchId: string) => ({
  batchId,
  containedAt: new Date(),
  suspended: snapshot.banned === true,
  creditDelta: snapshot.creditDelta ?? 0,
  apiKeysRevoked: snapshot.apiKeys?.length ?? 0,
  snapshot,
});

/**
 * Resolves a lost dispute on a user's payment and contains the account: suspended, credits to zero
 * and live API keys revoked, and its Stripe subscriptions canceled, as the admin bulk Contain does,
 * attributed to the system. The dispute flag is set (or stays set). The Contain and the resolution commit in one transaction, so a redelivered close (or
 * a concurrent one) finds the dispute resolved and changes nothing, and the record keeps the undo.
 * An admin account is never contained automatically; its dispute is resolved and left to a human.
 */
export async function resolveLostUserDispute(
  dispute: StripeDisputeItem,
  user: { id: string; isAdmin?: boolean | null },
  logger: Logger
): Promise<LostDisputeOutcome> {
  if (dispute.state === 'resolved') return { status: 'already_resolved' };
  const { stripeDisputeId } = dispute;

  // A holder, not a `let`: TypeScript does not see the callback's assignment.
  const contained: { item: StripeDisputeItem | null } = { item: null };
  if (!user.isAdmin) {
    const batchId = `stripe-dispute:${stripeDisputeId}`;
    const reason = `Lost Stripe dispute ${stripeDisputeId}`;
    try {
      const snapshot = await applyActionToUser(
        user.id,
        {
          action: { type: 'contain' },
          actorId: DISPUTE_SYSTEM_ACTOR_ID,
          reason,
          batchId,
          cancelDeadline: Date.now() + SUBSCRIPTION_CANCEL_GRACE_MS,
        },
        usersBulkSystemApplyDeps(SYSTEM_ACTOR_NAME, reason, logger),
        async snapshot => {
          contained.item = await stripeDisputeRepository.resolveBySystem(
            stripeDisputeId,
            'lost',
            containOf(snapshot, batchId)
          );
          // Rolls the Contain back: whoever resolved it first already acted.
          if (!contained.item) throw new DisputeAlreadyResolved();
          await keepBlocked(user.id);
        }
      );
      // A transaction retry can roll back an attempt that set the holder and then commit with no steps.
      if (!snapshot) contained.item = null;
      // Canceled after the commit, so the undo snapshot written inside it does not hold them yet. Best-effort:
      // the Contain stands, and a redelivered close would find the dispute resolved and never retry this.
      if (contained.item && snapshot?.canceledSubscriptions) {
        await stripeDisputeRepository
          .recordContainCanceledSubscriptions(stripeDisputeId, snapshot.canceledSubscriptions)
          .catch((error: unknown) =>
            logger.error('Recording a dispute Contain canceled subscriptions failed', { stripeDisputeId, error })
          );
      }
    } catch (error) {
      if (error instanceof DisputeAlreadyResolved) return { status: 'already_resolved' };
      throw error;
    }
  }
  if (contained.item) {
    await auditSystemResolution(contained.item, 'resolved a lost Stripe dispute and contained the account', logger);
    return { status: 'contained', item: contained.item };
  }

  // One transaction, so a failed flag write rolls the resolution back and the retried close sets it.
  const resolved = await withTransaction(
    async () => {
      const item = await stripeDisputeRepository.resolveBySystem(stripeDisputeId, 'lost');
      if (item) await keepBlocked(user.id);
      return item;
    },
    { logger }
  );
  if (!resolved) return { status: 'already_resolved' };
  await auditSystemResolution(resolved, 'resolved a lost Stripe dispute; the account needed no Contain', logger);
  return { status: 'resolved_without_contain', item: resolved };
}

export class DisputeContainUndoRefused extends Error {
  constructor(
    readonly result: { status: 'conflict' | 'account_changed'; item: StripeDisputeItem } | { status: 'not_found' }
  ) {
    super('Dispute Contain undo refused');
  }
}

/**
 * The snapshot adds back what the Contain removed, so replaying it over a later change would stack on
 * top of it (credits re-granted by hand would be granted twice). Only an account still in the Contain's
 * after-state is reverted; anything else is for an admin to adjust by hand. A balance below zero is
 * still that state (usage in flight at the Contain settled afterwards), but any credits added since
 * are not, even when they were spent back down.
 */
async function isStillContained(user: BulkUser, snapshot: UserUndoSnapshot, containedAt: Date): Promise<boolean> {
  if (snapshot.banned && !user.isBanned) return false;
  if (!snapshot.creditDelta) return true;
  if (user.currentCredits > 0) return false;
  const added = await creditTransactionRepository.findLedgerPage(user.id, CreditHolderType.User, {
    types: CREDIT_ADD_TRANSACTION_TYPES,
    createdFrom: containedAt,
    limit: 1,
  });
  return added.length === 0;
}

/**
 * An admin undoes the automatic Contain of a lost dispute: unsuspends, restores the credits it removed
 * and leaves the keys it revoked off (the account stays blocked while the dispute flag is set, and
 * the user creates new keys). The revert and the record's `undoneAt` commit together, so it runs once. Throws
 * DisputeContainUndoRefused when there is nothing to undo, when it was already undone, or when the
 * account changed since the Contain.
 */
export async function undoDisputeContain(
  dispute: StripeDisputeItem & { containSnapshot: unknown },
  adminId: string,
  deps: RevertDeps
): Promise<StripeDisputeItem> {
  const { contain } = dispute;
  if (!contain || contain.undoneAt) throw new DisputeContainUndoRefused({ status: 'conflict', item: dispute });
  const parsed = UserUndoSnapshotSchema.safeParse(dispute.containSnapshot);
  // Written by resolveLostUserDispute: a snapshot that no longer parses is a bug, not a client error.
  if (!parsed.success) throw new Error(`Corrupt dispute Contain snapshot: ${parsed.error.message}`);

  const undone: { item: StripeDisputeItem | null } = { item: null };
  await revertUserSnapshot(
    parsed.data,
    {
      batchId: contain.batchId,
      adminId,
      action: 'contain',
      undoExpiresAt: new Date().toISOString(),
      users: [parsed.data],
    },
    deps,
    {
      assertRevertable: async user => {
        if (!(await isStillContained(user, parsed.data, contain.containedAt))) {
          throw new DisputeContainUndoRefused({ status: 'account_changed', item: dispute });
        }
      },
      onReverted: async () => {
        const result = await stripeDisputeRepository.markContainUndone({ id: dispute.id, adminId });
        if (result.status !== 'updated') throw new DisputeContainUndoRefused(result);
        undone.item = result.item;
      },
    }
  );
  if (!undone.item) throw new Error(`Dispute Contain undo did not record for ${dispute.stripeDisputeId}`);
  return undone.item;
}
