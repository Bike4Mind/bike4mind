import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, userRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import mailer from './mailer';

export interface LakeOwnershipOfferEmailEvent {
  kind: dataLakeService.OwnershipOfferEmailKind;
  /** The recipient of THIS email: the offerer on an outcome, the offered-to member on an offer. */
  toUserId: string;
  dataLakeId: string;
  /**
   * Display name of the other party. Optional; the copy falls back to a role word rather than a
   * blank slot when a user record carries neither name nor username.
   */
  counterpartName?: string;
  /** The offer's expiry, named only in the `offered` copy. */
  expiresAt?: Date;
}

interface NotifierPorts {
  logger?: Logger;
  mailer?: { sendEmail: (to: string, data: unknown) => Promise<unknown> };
  users?: { findById: (id: string) => Promise<{ email?: string | null } | null> };
  lakes?: { findById: (id: string) => Promise<{ name: string } | null> };
}

/**
 * Send one ownership-offer email. BEST-EFFORT, like every mail side-effect in this app: it is called
 * AFTER the operation has committed, so a mail failure must never surface as a failed operation.
 *
 * `MailService.sendEmail` already swallows delivery errors and returns false. This adds the two cases
 * it cannot see - the recipient has no address, and the lake looked up for its display name is gone -
 * and logs both rather than dropping them silently, since the only other symptom is an email that
 * never arrived.
 *
 * Lives in apps/client because the renderer (b4m-core/services) cannot import @bike4mind/database or
 * this app's mailer.
 */
export const sendLakeOwnershipOfferEmail = async (
  event: LakeOwnershipOfferEmailEvent,
  { logger, mailer: mail = mailer, users = userRepository, lakes = dataLakeRepository }: NotifierPorts = {}
): Promise<void> => {
  try {
    const [user, lake] = await Promise.all([users.findById(event.toUserId), lakes.findById(event.dataLakeId)]);
    if (!user?.email) {
      logger?.warn?.('[dataLakes] ownership offer email skipped: no address for the recipient', {
        kind: event.kind,
        toUserId: event.toUserId,
        dataLakeId: event.dataLakeId,
      });
      return;
    }
    if (!lake) {
      logger?.warn?.('[dataLakes] ownership offer email skipped: the data lake no longer exists', {
        kind: event.kind,
        dataLakeId: event.dataLakeId,
      });
      return;
    }

    const content = dataLakeService.renderOwnershipOfferEmail({
      kind: event.kind,
      lakeName: lake.name,
      ...(event.counterpartName ? { counterpartName: event.counterpartName } : {}),
      ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
    });
    await mail.sendEmail(user.email, { subject: content.subject, html: content.html });
  } catch (err) {
    logger?.warn?.('[dataLakes] ownership offer email failed', {
      kind: event.kind,
      toUserId: event.toUserId,
      dataLakeId: event.dataLakeId,
      err,
    });
  }
};
