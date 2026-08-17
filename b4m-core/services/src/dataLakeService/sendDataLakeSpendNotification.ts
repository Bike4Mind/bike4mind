import type {
  DataLakeSpendNotificationDetail,
  DataLakeSpendNotificationKind,
  DataLakeSpendNotificationScope,
  IDataLakeAccessGrantRepository,
  IDataLakeDocument,
  IDataLakeRepository,
  IDataLakeSpendNotificationRepository,
  IOrganizationRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { resolveLakeSpendAddressees, type LakeSpendAddresseeDb } from './resolveLakeSpendAddressees';
import { renderSpendNotificationEmail } from './renderSpendNotificationEmail';

export type SpendNotificationOutcome = 'sent' | 'deduped' | 'no-addressees' | 'failed';

export interface DataLakeSpendNotificationEvent {
  dataLakeId: string;
  kind: DataLakeSpendNotificationKind;
  scope: DataLakeSpendNotificationScope;
  periodKey: string;
  thresholdPct?: number;
  detail: DataLakeSpendNotificationDetail;
}

export interface SpendNotificationMailer {
  /** Mirrors the app-layer MailService.sendEmail signature. Returns false on SMTP failure, never throws. */
  sendEmail(to: string, data: { subject: string; html: string }): Promise<unknown>;
}

export interface SendSpendNotificationDb extends LakeSpendAddresseeDb {
  dataLakes: Pick<IDataLakeRepository, 'findById'>;
  dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake'>;
  organizations: Pick<IOrganizationRepository, 'findById'>;
  spendNotifications: Pick<IDataLakeSpendNotificationRepository, 'claimNotification' | 'markDelivered' | 'delete'>;
}

/**
 * Bounds the addressee-resolution + send portion only (never the claim itself, which stays
 * fast/synchronous-ish and un-raced). Deliberately shorter than the gate's own outer
 * DEFAULT_NOTIFY_TIMEOUT_MS (3_000ms, enforceEmbeddingSpendGate.ts) so this timeout is the one
 * that fires in the common case, leaving time to mark the claim before the gate's own race
 * abandons the whole notify() call.
 */
export const DEFAULT_SEND_TIMEOUT_MS = 2_500;

/**
 * Resolve addressees and send, on an already-claimed row. Split out so the caller can race it
 * against a timeout without racing the claim call above it.
 *
 * `dispatchedRef` is set to true immediately BEFORE the actual sends start (not before addressee
 * resolution) - a mutable ref, not a return value, because a losing `Promise.race` abandons this
 * function's promise rather than cancelling it: the underlying sends keep running in the
 * background and the caller's catch block needs to see whether they were ever started, even
 * though it can never see this function's own return value.
 */
async function sendToAddressees(
  event: DataLakeSpendNotificationEvent,
  lake: IDataLakeDocument | null,
  claimId: string,
  db: SendSpendNotificationDb,
  mailer: SpendNotificationMailer,
  logger: Logger | undefined,
  dispatchedRef: { dispatched: boolean }
): Promise<SpendNotificationOutcome> {
  const addressees = await resolveLakeSpendAddressees(event.dataLakeId, db, logger, lake);
  if (addressees.length === 0) {
    // Keep the claim (do not delete it) - deleting would re-arm and make every subsequent
    // call on an ownerless lake redo the lake/grant/org/user reads for nothing.
    await db.spendNotifications.markDelivered(claimId, {
      recipientUserIds: [],
      deliveredCount: 0,
      deliveryFailed: false,
    });
    logger?.warn?.(`[sendDataLakeSpendNotification] no addressees for lake ${event.dataLakeId}`);
    return 'no-addressees';
  }

  const rendered = renderSpendNotificationEmail({
    kind: event.kind,
    scope: event.scope,
    lakeName: lake?.name ?? 'a data lake',
    detail: event.detail,
  });

  dispatchedRef.dispatched = true;
  // One message PER RECIPIENT - never a comma-joined `to:` - so org admins never learn each
  // other's addresses from a spend alert.
  const results = await Promise.allSettled(addressees.map(a => mailer.sendEmail(a.email, rendered)));
  const deliveredCount = results.filter(r => r.status === 'fulfilled' && r.value !== false).length;
  const deliveryFailed = deliveredCount === 0;

  await db.spendNotifications.markDelivered(claimId, {
    recipientUserIds: addressees.map(a => a.userId),
    deliveredCount,
    deliveryFailed,
  });

  return deliveryFailed ? 'failed' : 'sent';
}

/**
 * One lake read always happens first - its organizationId is denormalized onto the claim row
 * via $setOnInsert, so it is needed before the claim can be taken. From there the dominant
 * hot-path case (a lake already notified this period) short-circuits on ONE indexed claim
 * call, before any grant/org/user read or SMTP attempt. Never throws - every failure resolves
 * to `'failed'` and is logged, so a notification problem can never break the ingestion path it
 * reports on.
 */
export async function sendDataLakeSpendNotification(
  event: DataLakeSpendNotificationEvent,
  deps: { db: SendSpendNotificationDb; mailer: SpendNotificationMailer; logger?: Logger; sendTimeoutMs?: number }
): Promise<SpendNotificationOutcome> {
  const { db, mailer, logger } = deps;
  const sendTimeoutMs = deps.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  let claimId: string | undefined;
  // Cleared on the fast (common) path in the finally below - an uncleared setTimeout keeps a
  // Lambda's event loop non-empty for the full sendTimeoutMs even after sendToAddressees
  // already resolved.
  let sendTimer: ReturnType<typeof setTimeout> | undefined;
  // Set by sendToAddressees the instant real sends start, NOT when the race times out - a slow
  // but working mailer can still deliver mail after this function gives up on it.
  const dispatchedRef = { dispatched: false };
  try {
    const lake = await db.dataLakes.findById(event.dataLakeId);
    const claim = await db.spendNotifications.claimNotification({
      dataLakeId: event.dataLakeId,
      organizationId: lake?.organizationId ?? undefined,
      kind: event.kind,
      scope: event.scope,
      periodKey: event.periodKey,
      thresholdPct: event.thresholdPct,
      detail: event.detail,
    });
    if (!claim.claimed || !claim.id) return 'deduped';
    claimId = claim.id;

    return await Promise.race([
      sendToAddressees(event, lake, claim.id, db, mailer, logger, dispatchedRef),
      new Promise<never>((_, reject) => {
        sendTimer = setTimeout(() => reject(new Error(`send exceeded ${sendTimeoutMs}ms`)), sendTimeoutMs);
      }),
    ]);
  } catch (err) {
    logger?.warn?.(`[sendDataLakeSpendNotification] failed for lake ${event.dataLakeId}: ${err}`);
    if (claimId && !dispatchedRef.dispatched) {
      // DELETE, not markDelivered(deliveryFailed:true): claimNotification's upsert keys purely
      // on (dataLakeId, kind, scope, periodKey) and never reads deliveryFailed, so a flag alone
      // would leave the row permanently deduped with an unknown real outcome. Deleting frees the
      // unique-index slot so a future crossing of the SAME period gets a fresh, genuine attempt -
      // best-effort: if this delete itself fails, the claim stands (matches the pre-existing
      // fail-safe posture: a notification problem never re-throws into the ingestion path).
      //
      // Guarded on !dispatched: once real sends are in flight, the abandoned sendToAddressees
      // promise is not cancelled and can still deliver mail after this catch runs. Deleting the
      // claim in that case would free the slot for a re-send of mail that already went out -
      // exactly the storm the period-key fix was written to prevent, just from a different
      // angle. Leaving the row standing here means the eventual (possibly late) markDelivered
      // from that still-running send is the one that records the real outcome.
      await db.spendNotifications
        .delete(claimId)
        .catch(deleteErr =>
          logger?.warn?.(`[sendDataLakeSpendNotification] failed to delete claim ${claimId} for re-arm: ${deleteErr}`)
        );
    }
    return 'failed';
  } finally {
    clearTimeout(sendTimer);
  }
}
