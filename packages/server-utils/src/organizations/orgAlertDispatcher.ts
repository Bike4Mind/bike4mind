import {
  InboxType,
  orgAlertPeriodKey,
  requireEnv,
  resolveOrgAlertOptIn,
  type OrgAlertKind,
  type OrgAlertRecipientRole,
} from '@bike4mind/common';
import {
  inboxRepository,
  orgAdminNotificationPrefRepository,
  orgAlertNotificationRepository,
  organizationRepository,
  userRepository,
} from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import type { OrgEvent } from '@bike4mind/services/organizationService/orgEventObserver';
import { EmailEvents } from '../utils/eventBus';
import { buildOrgAlertEmailBody, toOrgAlertSubject } from '../utils/mailer/orgAlertEmails';

// Built on first use: baseApi imports this module on every route, and route tests often mock
// @bike4mind/observability without a Logger.
let cachedLogger: Logger | null = null;
const log = (): Logger => (cachedLogger ??= new Logger({ metadata: { component: 'orgAlertDispatcher' } }));

export interface DispatchOrgAlertInput {
  organizationId: string;
  kind: OrgAlertKind;
  /** Dedup scope within the period, e.g. `pct:80` or `user:<id>` (see IOrgAlertNotification). */
  scope: string;
  periodKey?: string;
  subjectUserId?: string | null;
  /** Short heading used as the email subject and Inbox title; the org name is appended. */
  title: string;
  /** Plain-text body shared by the email and the Inbox entry. */
  message: string;
  /** Recipients who still get the Inbox entry but no email (they were already emailed elsewhere). */
  excludeEmailUserIds?: readonly string[];
}

export interface DispatchOrgAlertResult {
  claimed: boolean;
  recipientUserIds: string[];
  delivered: number;
}

interface Recipient {
  userId: string;
  role: OrgAlertRecipientRole;
}

/**
 * Send one org alert to the owner and opted-in current managers, at most once per
 * (org, kind, scope, period). Never throws: a failed send must not fail the debit, roster change
 * or webhook that raised it. The claim is released only when no delivery attempt succeeded, so a
 * later event can retry; a claim with nobody to notify is kept.
 */
export async function dispatchOrgAlert(input: DispatchOrgAlertInput): Promise<DispatchOrgAlertResult> {
  const none: DispatchOrgAlertResult = { claimed: false, recipientUserIds: [], delivered: 0 };
  let claimId: string | undefined;
  try {
    const org = await organizationRepository.findById(input.organizationId);
    if (!org || org.personal || !org.userId) return none;

    const claim = await orgAlertNotificationRepository.claim({
      organizationId: input.organizationId,
      kind: input.kind,
      scope: input.scope,
      periodKey: input.periodKey ?? orgAlertPeriodKey(),
      subjectUserId: input.subjectUserId,
    });
    if (!claim.claimed) return none;
    claimId = claim.id;

    const memberIds = new Set((org.users ?? []).map(member => member.userId));
    // Same "current admin" rule as isOrgOwnerOrCurrentAdmin: an appointment without a member row confers nothing.
    const candidates: Recipient[] = [
      { userId: org.userId, role: 'owner' },
      ...[...new Set(org.adminUserIds ?? [])]
        .filter(id => id !== org.userId && memberIds.has(id))
        .map(userId => ({ userId, role: 'manager' as const })),
    ];
    const prefs = await orgAdminNotificationPrefRepository.getForOrg(input.organizationId);
    const prefByUser = new Map(prefs.map(row => [row.userId, row]));
    const recipients = candidates.filter(r => resolveOrgAlertOptIn(r.role, prefByUser.get(r.userId), input.kind));
    if (recipients.length === 0) return { claimed: true, recipientUserIds: [], delivered: 0 };

    const title = toOrgAlertSubject(`${input.title} - ${org.name}`);
    const appUrl = requireEnv('APP_URL', process.env.APP_URL).replace(/\/+$/, '');
    const body = buildOrgAlertEmailBody({
      organizationName: org.name,
      heading: input.title,
      message: input.message,
      settingsUrl: `${appUrl}/organizations/${input.organizationId}?tab=settings`,
    });
    const skipEmail = new Set(input.excludeEmailUserIds ?? []);

    let delivered = 0;
    let attempted = 0;
    for (const { userId } of recipients) {
      attempted++;
      try {
        await inboxRepository.createInboxMessage({
          userId: 'SYSTEM',
          receiverId: userId,
          type: InboxType.COMMON,
          title,
          message: input.message,
        });
        delivered++;
      } catch (error) {
        log().warn('Org alert inbox write failed', { organizationId: input.organizationId, kind: input.kind, error });
      }
      if (skipEmail.has(userId)) continue;
      attempted++;
      try {
        const user = await userRepository.findById(userId);
        if (!user?.email) continue;
        await EmailEvents.Send.publish({ to: user.email, subject: title, body });
        delivered++;
      } catch (error) {
        log().warn('Org alert email failed', { organizationId: input.organizationId, kind: input.kind, error });
      }
    }

    if (delivered === 0 && attempted > 0) await releaseQuietly(claimId);
    return { claimed: true, recipientUserIds: recipients.map(r => r.userId), delivered };
  } catch (error) {
    log().error('Org alert dispatch failed', { organizationId: input.organizationId, kind: input.kind, error });
    if (claimId) await releaseQuietly(claimId);
    return none;
  }
}

async function releaseQuietly(id: string | undefined): Promise<void> {
  if (!id) return;
  try {
    await orgAlertNotificationRepository.release(id);
  } catch (error) {
    log().warn('Could not release org alert claim; it will not retry this period', { error });
  }
}

/** Maps an org event to its alert. Threshold kinds are evaluated by their own modules before dispatch. */
export async function handleOrgEvent(event: OrgEvent): Promise<void> {
  switch (event.type) {
    case 'seat_limit':
      await dispatchOrgAlert({
        organizationId: event.organizationId,
        kind: 'seat_limit',
        scope: `seats:${event.seats}`,
        title: 'Seat limit reached',
        message: `Someone could not join because all ${event.seats} seats are in use. Add seats from the Billing tab to let more people in.`,
      });
      return;
    case 'member_joined':
      await dispatchOrgAlert({
        organizationId: event.organizationId,
        kind: 'member_joined',
        scope: `user:${event.userId}`,
        subjectUserId: event.userId,
        title: 'New member joined',
        message: 'A new member joined your organization. Review the roster from the Members tab.',
      });
      return;
    case 'payment_failed':
      await dispatchOrgAlert({
        organizationId: event.organizationId,
        kind: 'payment_failed',
        scope: `invoice:${event.invoiceId}`,
        title: 'Subscription payment failed',
        message: 'A renewal payment for your organization failed. The owner can update the card from the Billing tab.',
      });
      return;
    case 'credit_debit':
      return;
  }
}
