import { postMessageToSlack } from '@server/integrations/slack/slack';
import { AdminOrgAuditEvents, logAuditEvent } from '@server/utils/auditLog';

interface SeatCeilingRaisedLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/** Which path triggered the raise - carried into the alert + audit for traceability. */
type SeatCeilingRaiseTrigger = 'otc-signup' | 'email-verification' | 'admin-backfill';

interface SeatCeilingRaisedParams {
  organizationId: string;
  /** The domain-verified user admitted by the raise. */
  userId: string;
  previousSeats: number;
  newSeats: number;
  trigger: SeatCeilingRaiseTrigger;
  /** The admin who ran a bulk raise (backfill). Recorded as the audit actor; absent on live signup. */
  actingAdminId?: string;
}

/**
 * Write the AUDIT record for a partner-rule seat-ceiling raise (#1239) - no Slack.
 *
 * Every path that can grow an org's seat count without an admin seat change must leave a durable
 * record ("who added seats and why"), including the admin backfill, which raises many ceilings in
 * one deliberate action and so skips the per-raise Slack ping. Best-effort: `logAuditEvent` swallows
 * its own errors; the membership + seat raise have already committed by the time this runs.
 */
export async function auditSeatCeilingRaised(
  { organizationId, userId, previousSeats, newSeats, trigger, actingAdminId }: SeatCeilingRaisedParams,
  logger?: SeatCeilingRaisedLogger
): Promise<void> {
  await logAuditEvent(
    {
      userId,
      action: AdminOrgAuditEvents.ORG_SEAT_CEILING_RAISED,
      reason: `partner-rule domain signup (${trigger})`,
      ...(actingAdminId ? { adminUserId: actingAdminId } : {}),
      metadata: { organizationId, previousSeats, newSeats, trigger },
    },
    logger
  );
}

/**
 * Fire the human ALERT (Slack) + AUDIT record for a partner-rule seat-ceiling raise on a live
 * signup (#1239).
 *
 * Domain-signup provisioning raises the seat ceiling rather than rejecting a legit partner user at
 * capacity, so the billing owner's seat count can grow without any admin action. That is only
 * acceptable if every raise is loud: this posts to the LiveOps Slack channel AND writes an
 * ORG_SEAT_CEILING_RAISED audit event.
 *
 * Best-effort and never throws: both underlying calls swallow their own errors, and this wraps them
 * so an alerting hiccup can never break an already-successful signup/verification. The core service
 * has already committed the membership + seat raise by the time this runs.
 */
export async function notifySeatCeilingRaised(
  params: SeatCeilingRaisedParams,
  logger?: SeatCeilingRaisedLogger
): Promise<void> {
  const { organizationId, userId, previousSeats, newSeats, trigger } = params;
  try {
    await Promise.all([
      postMessageToSlack(
        `🎟️ *Org seat ceiling auto-raised*\n` +
          `*Organization:* ${organizationId}\n` +
          `*Seats:* ${previousSeats} -> ${newSeats}\n` +
          `*Admitted user:* ${userId}\n` +
          `*Trigger:* ${trigger} (partner-rule domain signup)`
      ),
      auditSeatCeilingRaised(params, logger),
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

interface PartnerSignupBlockedParams {
  organizationId: string;
  /** The domain-verified user who could not be admitted. */
  userId: string;
  /** The org's current (unchanged) seat ceiling. */
  seats: number;
  trigger: SeatCeilingRaiseTrigger;
}

/**
 * Alert (Slack) that a partner-rule domain signup was BLOCKED because a Stripe-billed org was at
 * capacity and its ceiling is deliberately not raised out of band (#1239).
 *
 * This is the "loud" half of the reject: a legit partner user is stranded at the door, so an admin
 * must be told to add seats through the billing-aware path (which pushes the quantity to Stripe).
 * Best-effort and never throws - the signup/verification itself has already succeeded.
 */
export async function notifyPartnerSignupBlockedAtCapacity(
  { organizationId, userId, seats, trigger }: PartnerSignupBlockedParams,
  logger?: SeatCeilingRaisedLogger
): Promise<void> {
  try {
    await postMessageToSlack(
      `🚧 *Partner signup blocked - org at capacity*\n` +
        `*Organization:* ${organizationId} (Stripe-billed)\n` +
        `*Seats:* ${seats} (full; ceiling not auto-raised for a billed org)\n` +
        `*Blocked user:* ${userId}\n` +
        `*Trigger:* ${trigger} (partner-rule domain signup)\n` +
        `Add seats to admit this user.`
    );
  } catch (error) {
    logger?.error('Failed to alert partner-rule signup blocked at capacity', {
      organizationId,
      userId,
      seats,
      trigger,
      error,
    });
  }
}
