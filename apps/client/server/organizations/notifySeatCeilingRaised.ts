import { postMessageToSlack } from '@bike4mind/server-utils/integrations/slack/slack';
import { adminAuditLogRepository } from '@bike4mind/database';
import { adminAuditService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database/auth';
import type { AuditActor } from '@bike4mind/common';
import { systemAuditActor } from '@server/utils/adminAudit';

interface SeatCeilingRaisedLogger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

/** Which path triggered the raise - carried into the alert + audit for traceability. */
export type SeatCeilingRaiseTrigger =
  | 'otc-signup'
  | 'otc-login-verification'
  | 'email-verification'
  | 'oauth-signup'
  | 'oauth-link-verification'
  | 'admin-verification'
  | 'admin-backfill';

interface SeatCeilingRaisedParams {
  organizationId: string;
  /** The domain-verified user admitted by the raise. */
  userId: string;
  previousSeats: number;
  newSeats: number;
  trigger: SeatCeilingRaiseTrigger;
  /** The admin who ran a bulk raise (backfill). Becomes the audit actor; absent on live signup. */
  actingAdminId?: string;
}

const resolveAdminActor = async (adminId: string, logger?: SeatCeilingRaisedLogger): Promise<AuditActor> => {
  try {
    const admin = await userRepository.findById(adminId);
    if (admin) {
      return {
        kind: 'user',
        scope: 'platform',
        userId: adminId,
        email: admin.email ?? undefined,
        name: admin.name || admin.username,
        wasAdmin: true,
      };
    }
  } catch (error) {
    // Attribution must not abort the raise; the fallback actor still names who acted.
    logger?.error('[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]', { adminId, error });
    return unknownAdminActor(adminId);
  }
  logger?.error('[ADMIN_AUDIT_ACTOR_LOOKUP_FAILED]', { adminId, error: 'user not found' });
  return unknownAdminActor(adminId);
};

const unknownAdminActor = (adminId: string): AuditActor => ({
  kind: 'user',
  scope: 'platform',
  userId: adminId,
  name: 'Unknown admin',
  wasAdmin: true,
});

/**
 * Write the AUDIT record for a partner-rule seat-ceiling raise (#1239) - no Slack.
 *
 * Every path that can grow an org's seat count without an admin seat change must leave a durable
 * record ("who added seats and why"), including the admin backfill, which raises many ceilings in
 * one deliberate action and so skips the per-raise Slack ping. Best-effort: the writer swallows
 * its own errors; the membership + seat raise have already committed by the time this runs.
 */
export async function auditSeatCeilingRaised(
  { organizationId, userId, previousSeats, newSeats, trigger, actingAdminId }: SeatCeilingRaisedParams,
  logger?: SeatCeilingRaisedLogger
): Promise<void> {
  const actor = actingAdminId ? await resolveAdminActor(actingAdminId, logger) : systemAuditActor('Seat ceiling');
  await adminAuditService.recordAdminAction(
    {
      action: 'org.seats.ceiling_raised',
      actor,
      target: { kind: 'organization', id: organizationId, displayName: organizationId },
      summary: `raised seat ceiling from ${previousSeats} to ${newSeats}`,
      reason: `partner-rule domain signup (${trigger})`,
      context: { source: actingAdminId ? 'script' : 'worker' },
      details: { userId, previousSeats, newSeats, trigger },
    },
    { db: { adminAuditLog: adminAuditLogRepository }, logger }
  );
}

/**
 * Fire the human ALERT (Slack) + AUDIT record for a partner-rule seat-ceiling raise on a live
 * signup (#1239).
 *
 * Domain-signup provisioning raises the seat ceiling rather than rejecting a legit partner user at
 * capacity, so the billing owner's seat count can grow without any admin action. That is only
 * acceptable if every raise is loud: this posts to the LiveOps Slack channel AND writes an
 * org.seats.ceiling_raised audit entry.
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
