import type { ClientSession } from 'mongoose';
import { Inbox } from '../models/social/InboxModel';
import { OrgAdminNotificationPrefModel } from '../models/infra/admin/OrgAdminNotificationPrefModel';
import { OrgAlertNotificationModel } from '../models/infra/admin/OrgAlertNotificationModel';

/** Remove only this account's ownership/subject references, preserving organization-wide claims. */
export async function deleteOrgAlertsForUser(
  userId: string,
  { session, assertLease }: { session?: ClientSession; assertLease?: () => Promise<void> } = {}
): Promise<void> {
  const canonicalId = userId.toLowerCase();
  await assertLease?.();
  await OrgAdminNotificationPrefModel.deleteMany({ userId: canonicalId }, session ? { session } : {});
  await assertLease?.();
  await OrgAlertNotificationModel.deleteMany({ subjectUserId: canonicalId }, session ? { session } : {});
  await assertLease?.();
  // Permanent erasure of this producer's rows only; preserve the existing admin policy for ordinary Inbox.
  await Inbox.collection.deleteMany({ receiverId: canonicalId, organizationAlert: true }, session ? { session } : {});
}
