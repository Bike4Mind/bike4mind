import { postMessageToSlack } from '@server/integrations/slack/slack';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';

interface SeatCeilingRaisedLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

interface NotifySeatCeilingRaisedParams {
  organizationId: string;
  /** The domain-verified user admitted by the raise. */
  userId: string;
  previousSeats: number;
  newSeats: number;
  /** Which signup route triggered the raise - carried into the alert + audit for traceability. */
  trigger: 'otc-signup' | 'email-verification';
}

/**
 * Fire the human ALERT (Slack) + AUDIT record for a partner-rule seat-ceiling raise (#1239).
 *
 * Domain-signup provisioning raises the seat ceiling rather than rejecting a legit partner user at
 * capacity, so the billing owner's seat count can grow without any admin action. That is only
 * acceptable if every raise is loud: this posts to the LiveOps Slack channel AND writes an
 * ORG_SEAT_CEILING_RAISED audit event so "who added seats and why" is always answerable.
 *
 * Best-effort and never throws: both underlying calls swallow their own errors, and this wraps them
 * so an alerting hiccup can never break an already-successful signup/verification. The core service
 * has already committed the membership + seat raise by the time this runs.
 */
export async function notifySeatCeilingRaised(
  { organizationId, userId, previousSeats, newSeats, trigger }: NotifySeatCeilingRaisedParams,
  logger?: SeatCeilingRaisedLogger
): Promise<void> {
  try {
    await Promise.all([
      postMessageToSlack(
        `🎟️ *Org seat ceiling auto-raised*\n` +
          `*Organization:* ${organizationId}\n` +
          `*Seats:* ${previousSeats} -> ${newSeats}\n` +
          `*Admitted user:* ${userId}\n` +
          `*Trigger:* ${trigger} (partner-rule domain signup)`
      ),
      logAuditEvent(
        {
          userId,
          action: AdminOrgAuditEvents.ORG_SEAT_CEILING_RAISED,
          reason: `partner-rule domain signup (${trigger})`,
          metadata: { organizationId, previousSeats, newSeats, trigger },
        },
        logger
      ),
    ]);
  } catch (error) {
    logger?.error('Failed to alert/audit partner-rule seat-ceiling raise', {
      organizationId,
      userId,
      previousSeats,
      newSeats,
      trigger,
      error,
    });
  }
}
