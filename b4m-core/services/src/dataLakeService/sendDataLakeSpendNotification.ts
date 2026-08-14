import type {
  DataLakeSpendNotificationDetail,
  DataLakeSpendNotificationKind,
  DataLakeSpendNotificationScope,
  IDataLakeAccessGrantRepository,
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
  spendNotifications: Pick<IDataLakeSpendNotificationRepository, 'claimNotification' | 'markDelivered'>;
}

/**
 * Claim-then-notify, in that order deliberately: the dominant hot-path case (a lake already
 * notified this period) short-circuits on ONE indexed claim call, before any lake/grant/org/
 * user read or SMTP attempt. Never throws - every failure resolves to `'failed'` and is
 * logged, so a notification problem can never break the ingestion path it reports on.
 */
export async function sendDataLakeSpendNotification(
  event: DataLakeSpendNotificationEvent,
  deps: { db: SendSpendNotificationDb; mailer: SpendNotificationMailer; logger?: Logger }
): Promise<SpendNotificationOutcome> {
  const { db, mailer, logger } = deps;
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

    const addressees = await resolveLakeSpendAddressees(event.dataLakeId, db, logger);
    if (addressees.length === 0) {
      // Keep the claim (do not delete it) - deleting would re-arm and make every subsequent
      // call on an ownerless lake redo the lake/grant/org/user reads for nothing.
      await db.spendNotifications.markDelivered(claim.id, {
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

    // One message PER RECIPIENT - never a comma-joined `to:` - so org admins never learn each
    // other's addresses from a spend alert.
    const results = await Promise.allSettled(addressees.map(a => mailer.sendEmail(a.email, rendered)));
    const deliveredCount = results.filter(r => r.status === 'fulfilled' && r.value !== false).length;
    const deliveryFailed = deliveredCount === 0;

    await db.spendNotifications.markDelivered(claim.id, {
      recipientUserIds: addressees.map(a => a.userId),
      deliveredCount,
      deliveryFailed,
    });

    return deliveryFailed ? 'failed' : 'sent';
  } catch (err) {
    logger?.warn?.(`[sendDataLakeSpendNotification] failed for lake ${event.dataLakeId}: ${err}`);
    return 'failed';
  }
}
