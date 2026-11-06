import {
  adminAuditLogRepository,
  adminGateReservationRepository,
  type AdminGateReservationKind,
} from '@bike4mind/database';
import { getApprovalPolicy, type ApprovalPolicy } from '@server/admin/approvals/service';

const HOUR_MS = 60 * 60 * 1000;

/** Releases the caller's window reservation; call it once the action and its audit rows are done, success or not. */
export type ReleaseWindow = () => Promise<void>;
export type CreditGrantGate = { policy: ApprovalPolicy } | { policy: null; release: ReleaseWindow };

const noRelease: ReleaseWindow = async () => undefined;
export const RUN_NOW: { policy: null; release: ReleaseWindow } = { policy: null, release: noRelease };

/**
 * Reserves `amount` for this admin, then judges `recorded` (the audit rows over the window) plus every
 * unexpired reservation, its own included, against `threshold`. Reserving before reading means of two
 * concurrent requests the later reader always sees both, so they cannot both pass on a stale sum; at
 * worst both are sent for approval. Over the threshold the reservation is dropped and null returned.
 */
export async function reserveWithinWindow(
  actorUserId: string,
  kind: AdminGateReservationKind,
  amount: number,
  threshold: number,
  windowMs: number,
  recorded: () => Promise<number>
): Promise<ReleaseWindow | null> {
  const now = new Date();
  const id = await adminGateReservationRepository.reserve(
    actorUserId,
    kind,
    amount,
    new Date(now.getTime() + windowMs)
  );
  // A reservation that fails to release only over-counts until it expires.
  const release: ReleaseWindow = () => adminGateReservationRepository.release(id).catch(() => undefined);
  try {
    const [audited, reserved] = await Promise.all([
      recorded(),
      adminGateReservationRepository.sumReserved(actorUserId, kind, now),
    ]);
    if (audited + reserved <= threshold) return release;
  } catch (error) {
    await release();
    throw error;
  }
  await release();
  return null;
}

/**
 * The policy when approvals are on and `credits`, plus what this admin granted or is granting over the
 * approval expiry window, is over the threshold (equal still runs). Otherwise the grant may run now and
 * its credits stay reserved until `release`, so a grant split into smaller ones, sent one after another
 * or all at once, is held to the same threshold as one large grant.
 */
export async function creditGrantNeedsApproval(credits: number, actorUserId: string): Promise<CreditGrantGate> {
  const policy = await getApprovalPolicy();
  if (!policy.enabled || credits <= 0) return RUN_NOW;
  if (credits > policy.creditThreshold) return { policy };
  const windowMs = policy.expiryHours * HOUR_MS;
  const since = new Date(Date.now() - windowMs);
  const release = await reserveWithinWindow(actorUserId, 'credits', credits, policy.creditThreshold, windowMs, () =>
    // Grants this admin ran as the approver of someone else's request were already reviewed.
    adminAuditLogRepository.sumCreditsGranted(actorUserId, since, { excludeApproved: true })
  );
  return release ? { policy: null, release } : { policy };
}
