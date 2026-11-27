import {
  ADMIN_GRANT_HARD_LIMIT,
  ADMIN_GRANT_IMMEDIATE_LIMIT,
  ADMIN_GRANT_LIMIT_ERROR_CODE,
  ADMIN_GRANT_WINDOW_MS,
  ForbiddenError,
  hasAdminPermission,
  type AdminApproval,
  type AdminAuditAction,
  type AdminGrantLimitRefusal,
} from '@bike4mind/common';
import {
  adminAuditLogRepository,
  adminGateReservationRepository,
  type AdminGateReservationKind,
} from '@bike4mind/database';
import {
  isSelfOrImpersonator,
  readAdminActionReason,
  type AdminAuditWriter,
} from '@bike4mind/server-utils/utils/adminAudit';
import type { CreditGrantHold, ExecuteDeps } from '@bike4mind/server-utils/admin/usersBulk/execute';
import { reserveWithinWindow, type ReleaseWindow } from './gate';
import { fenceExplicitOnlyPermissions } from './seniorGranters';
import { SELF_GRANT_APPROVAL } from './selfGrant';

/**
 * The per-recipient admin grant cap (b4m-core/common adminCreditGrants.ts): what one user, or the organization a
 * team grant funds, may receive from all admins over a rolling 24 hours. Up to the admin's immediate limit a
 * grant runs now; above it the whole grant becomes one approval request (never split); past
 * ADMIN_GRANT_HARD_LIMIT it is refused, approved or not, unless it is a subscription grant. Independent of
 * the approval gate beside it (gate.ts), which still applies to a grant that runs now.
 */

const DAY_MS = ADMIN_GRANT_WINDOW_MS;

type TierActor = {
  id: string;
  impersonatedBy?: string | null;
  isAdmin?: boolean | null;
  adminPermissions?: readonly string[] | null;
  roleAdminPermissions?: readonly string[] | null;
};

/**
 * Approver requirement of a grant over the immediate limit: the same one as a held self-grant
 * (selfGrant.ts), and only a listed account can decide it (approvals/service.ts canDecideAs).
 */
export const LARGE_GRANT_APPROVAL = SELF_GRANT_APPROVAL;

/** Whether the grant runs on an approval a listed approver gave for its whole amount. */
export const isLargeGrantApproval = (approval: AdminApproval | undefined): boolean =>
  approval?.requiredPermission === LARGE_GRANT_APPROVAL.requiredPermission;

/**
 * What the actor may grant one subject at once over 24 hours. A listed approver (`credits:approve_self_grant`)
 * grants others up to the hard limit, and a listed `credits:self_grant` holder grants themselves up to it;
 * everyone else, and every impersonated session, up to ADMIN_GRANT_IMMEDIATE_LIMIT. The list only raises the
 * limit: the actor still needs `credits:adjust`.
 */
export function immediateGrantLimit(actor: TierActor, targetsSelf: boolean): number {
  if (!hasAdminPermission(actor, 'credits:adjust')) return ADMIN_GRANT_IMMEDIATE_LIMIT;
  const fenced = fenceExplicitOnlyPermissions(actor);
  const raised = targetsSelf ? 'credits:self_grant' : 'credits:approve_self_grant';
  return hasAdminPermission(fenced, raised) ? ADMIN_GRANT_HARD_LIMIT : ADMIN_GRANT_IMMEDIATE_LIMIT;
}

export type CreditGrantCapRequest = {
  actor: TierActor;
  recipient: { id: string; displayName: string };
  /** False for a team subscription grant: its credits count against the organization, not the member. */
  countRecipient?: boolean;
  /** The existing organization a team grant funds; capped instead of the member. */
  organizationId?: string;
  /** Credits this grant adds; 0 or less (a deduction) is never capped. */
  credits: number;
  /** The grant credits the actor's own account, or an organization they belong to. */
  targetsSelf: boolean;
  /** A subscription grant pays every month up front, so the hard limit does not apply; approval is its control. */
  exemptFromHardLimit?: boolean;
  /** Whether this path can turn the grant into an approval request; bulk adjust and in-transaction rechecks cannot. */
  approvalAvailable: boolean;
  /** False where the caller cannot ask for the typed confirmation (bulk adjust). */
  confirmable?: boolean;
  /** Running on a listed approver's approval of the whole amount (isLargeGrantApproval): only the hard limit applies. */
  approved?: boolean;
  /** Set by the typed confirmation; only counts with a reason beside it. */
  confirmLargeGrant?: boolean;
  reason?: string;
  /** The grant action refused, named in the audit entry. */
  attemptedAction: AdminAuditAction;
};

export type CreditGrantRefusal = Omit<AdminGrantLimitRefusal, 'code'> & { message: string };

export type CreditGrantCapResult =
  | { outcome: 'immediate'; release: ReleaseWindow }
  | { outcome: 'approval' }
  | { outcome: 'refused'; refusal: CreditGrantRefusal };

type CapSubject = AdminGrantLimitRefusal['subject'];

/** What each capped subject reserves under and sums from the audit log. */
const SUBJECTS: Record<
  CapSubject,
  { kind: AdminGateReservationKind; noun: string; audited: (id: string, since: Date) => Promise<number> }
> = {
  user: {
    kind: 'recipientCredits',
    noun: 'This user',
    audited: (id, since) => adminAuditLogRepository.sumCreditsGrantedTo(id, since),
  },
  organization: {
    kind: 'organizationCredits',
    noun: 'This organization',
    audited: (id, since) => adminAuditLogRepository.sumCreditsGrantedToOrganization(id, since),
  },
};

const noRelease: ReleaseWindow = async () => undefined;
const formatCredits = (credits: number) => credits.toLocaleString('en-US');
const windowStart = () => new Date(Date.now() - DAY_MS);

/** Audited grants to the subject in the window plus every unexpired reservation for it. */
export async function receivedInWindow(subject: CapSubject, id: string): Promise<number> {
  const reserved = await adminGateReservationRepository.sumReserved(id, SUBJECTS[subject].kind, new Date());
  return (await SUBJECTS[subject].audited(id, windowStart())) + reserved;
}

type Judged = { subject: CapSubject; id: string; received: number };

const subjectsOf = ({ recipient, countRecipient = true, organizationId }: CreditGrantCapRequest) => [
  ...(countRecipient ? [{ subject: 'user' as const, id: recipient.id }] : []),
  ...(organizationId ? [{ subject: 'organization' as const, id: organizationId }] : []),
];

/**
 * `bound` is the limit the grant crossed; `needs` is what would let it past: a listed approver's approval
 * (above the admin's immediate limit) or only the typed confirmation (a listed approver above the immediate limit).
 */
function refusalFor(
  reason: CreditGrantRefusal['reason'],
  { subject, received }: Judged,
  bound: number,
  needs: 'approval' | 'confirmation'
): CreditGrantRefusal {
  const remaining = formatCredits(Math.max(0, bound - received));
  const head = `${SUBJECTS[subject].noun} has received ${formatCredits(received)} admin-granted credits in the last 24 hours.`;
  const above = `${needs === 'approval' ? 'Above' : 'Going above'} ${formatCredits(bound)}`;
  const messages: Record<CreditGrantRefusal['reason'], string> = {
    hard_limit: `${head} No grant can take it above ${formatCredits(bound)} in 24 hours, approved or not, so at most ${remaining} more can be granted.`,
    confirmation_required:
      needs === 'approval'
        ? `${head} ${above} the whole grant needs a senior granter's approval: type the confirmation and give a reason to submit it, or grant up to ${remaining} now.`
        : `${head} ${above} needs the typed confirmation and a reason, so without it you can grant up to ${remaining} more.`,
    approval_unavailable: `${head} ${above} a grant needs ${needs === 'approval' ? "a senior granter's approval, which this action cannot request" : 'the typed confirmation, which this action cannot take'}, so you can grant up to ${remaining} more now.`,
  };
  return {
    subject,
    reason,
    receivedCredits: received,
    remainingCredits: Math.max(0, bound - received),
    message: messages[reason],
  };
}

/** The first subject the grant takes past `limit`, if any. */
const firstOver = (judged: Judged[], credits: number, limit: number) =>
  judged.find(({ received }) => received + credits > limit);

/**
 * Judges a grant against the cap of each subject it counts against. `immediate`: it may run now and, with
 * `reserve` (the default), its credits are held per subject until `release`, so concurrent grants from any
 * admins cannot both pass on a stale sum. `approval`: the whole grant must go to a listed approver; nothing
 * is held. `refused`: written to the admin audit log through `writeAudit`. `reserve: false` only reads, for
 * a route's check before it decides between running the grant and queueing it.
 */
export async function checkCreditGrantCap(
  request: CreditGrantCapRequest,
  writeAudit: AdminAuditWriter,
  { reserve = true }: { reserve?: boolean } = {}
): Promise<CreditGrantCapResult> {
  const { actor, recipient, organizationId, credits } = request;
  if (credits <= 0) return { outcome: 'immediate', release: noRelease };
  const immediateLimit = immediateGrantLimit(actor, request.targetsSelf);
  const confirmed = request.confirmLargeGrant === true && readAdminActionReason(request.reason) !== undefined;
  const hardLimit = request.exemptFromHardLimit ? Number.POSITIVE_INFINITY : ADMIN_GRANT_HARD_LIMIT;
  const runLimit = request.approved ? hardLimit : immediateLimit;
  const subjects = subjectsOf(request);
  // A team grant to a new organization has no subject with history: judged on its own credits.
  const read = async (): Promise<Judged[]> =>
    subjects.length > 0
      ? Promise.all(subjects.map(async s => ({ ...s, received: await receivedInWindow(s.subject, s.id) })))
      : [{ subject: 'organization', id: '', received: 0 }];

  const refuse = async (
    reason: CreditGrantRefusal['reason'],
    over: Judged,
    bound: number,
    needs: 'approval' | 'confirmation' = 'approval'
  ): Promise<CreditGrantCapResult> => {
    const refusal = refusalFor(reason, over, bound, needs);
    await writeAudit({
      action: 'user.credits.denied',
      target: { kind: 'user', ...recipient },
      ...(organizationId && { organizationId }),
      summary: `refused a grant of ${formatCredits(credits)} credits over the 24-hour per-${over.subject} grant limit`,
      reason: readAdminActionReason(request.reason),
      details: {
        attemptedAction: request.attemptedAction,
        requestedCredits: credits,
        limitedBy: over.subject,
        refusal: reason,
        receivedCredits: over.received,
        immediateLimit,
        approved: request.approved === true,
        largeGrantConfirmed: confirmed,
      },
    });
    return { outcome: 'refused', refusal };
  };

  const judged = await read();
  const overHard = firstOver(judged, credits, hardLimit);
  if (overHard) return refuse('hard_limit', overHard, hardLimit);
  const overRun = firstOver(judged, credits, runLimit);
  if (overRun) {
    if (!request.approvalAvailable) return refuse('approval_unavailable', overRun, runLimit);
    if (!confirmed) return refuse('confirmation_required', overRun, runLimit);
    return { outcome: 'approval' };
  }
  // A listed approver's grant past the immediate limit still needs the phrase; an approved one gave it on request.
  const overUnconfirmed = request.approved ? undefined : firstOver(judged, credits, ADMIN_GRANT_IMMEDIATE_LIMIT);
  if (overUnconfirmed && !confirmed) {
    const reason = request.confirmable === false ? 'approval_unavailable' : 'confirmation_required';
    return refuse(reason, overUnconfirmed, ADMIN_GRANT_IMMEDIATE_LIMIT, 'confirmation');
  }
  if (!reserve || subjects.length === 0) return { outcome: 'immediate', release: noRelease };

  const held: ReleaseWindow[] = [];
  const releaseAll: ReleaseWindow = async () => {
    for (const release of held.splice(0)) await release();
  };
  try {
    for (const { subject, id } of subjects) {
      const passed = await reserveWithinWindow(id, SUBJECTS[subject].kind, credits, runLimit, DAY_MS, () =>
        SUBJECTS[subject].audited(id, windowStart())
      );
      if (passed) {
        held.push(passed);
        continue;
      }
      // Another grant landed since the read: judge again on what others now hold, as the pre-check would have.
      await releaseAll();
      const again = (await read()).find(j => j.subject === subject) ?? { subject, id, received: 0 };
      if (again.received + credits > hardLimit) return refuse('hard_limit', again, hardLimit);
      if (!request.approvalAvailable) return refuse('approval_unavailable', again, runLimit);
      if (!confirmed) return refuse('confirmation_required', again, runLimit);
      return { outcome: 'approval' };
    }
    // reserveWithinWindow judges only against runLimit, so concurrent unconfirmed grants from an admin whose
    // limit is above ADMIN_GRANT_IMMEDIATE_LIMIT could pass the phrase threshold together. Judge again with this
    // grant held, and refuse it if the total is now past the threshold.
    if (!confirmed && !request.approved && runLimit > ADMIN_GRANT_IMMEDIATE_LIMIT) {
      const over = (await read()).find(({ received }) => received > ADMIN_GRANT_IMMEDIATE_LIMIT);
      if (over) {
        await releaseAll();
        const reason = request.confirmable === false ? 'approval_unavailable' : 'confirmation_required';
        // `received` counted this grant's own hold, released above.
        return refuse(
          reason,
          { ...over, received: over.received - credits },
          ADMIN_GRANT_IMMEDIATE_LIMIT,
          'confirmation'
        );
      }
    }
    return { outcome: 'immediate', release: releaseAll };
  } catch (error) {
    await releaseAll();
    throw error;
  }
}

/**
 * checkCreditGrantCap for a single-recipient route: a refusal is a 403 carrying the AdminGrantLimitRefusal
 * fields, so the dialog can tell a missing confirmation from a hard refusal.
 */
export async function enforceCreditGrantCap(
  request: CreditGrantCapRequest,
  writeAudit: AdminAuditWriter,
  options?: { reserve?: boolean }
): Promise<{ outcome: 'immediate'; release: ReleaseWindow } | { outcome: 'approval' }> {
  const result = await checkCreditGrantCap(request, writeAudit, options);
  if (result.outcome !== 'refused') return result;
  const { message, ...fields } = result.refusal;
  const body: AdminGrantLimitRefusal = { code: ADMIN_GRANT_LIMIT_ERROR_CODE, ...fields };
  throw new ForbiddenError(message, body);
}

/** enforceCreditGrantCap where the grant must run now: an approval outcome cannot be returned. */
export async function enforceImmediateCreditGrant(
  request: Omit<CreditGrantCapRequest, 'approvalAvailable'>,
  writeAudit: AdminAuditWriter
): Promise<ReleaseWindow> {
  const result = await enforceCreditGrantCap({ ...request, approvalAvailable: false }, writeAudit);
  if (result.outcome !== 'immediate') throw new Error('An immediate grant cap check returned an approval outcome');
  return result.release;
}

/** The users bulk executor's `capCreditGrant` (server-utils usersBulk/execute.ts): one refusal fails one user. */
export const usersBulkCreditGrantCap =
  (actor: TierActor, writeAudit: AdminAuditWriter, reason: string): NonNullable<ExecuteDeps['capCreditGrant']> =>
  async (user, credits): Promise<CreditGrantHold> => {
    const result = await checkCreditGrantCap(
      {
        actor,
        recipient: { id: user.id, displayName: user.email ?? user.username ?? user.id },
        credits,
        targetsSelf: isSelfOrImpersonator(actor, user.id),
        // A batch adds at most ADMIN_USERS_BULK_MAX_CREDIT_ADD (the immediate limit) per user and cannot queue
        // one user's grant for approval, so a user it would take past the admin's limit fails on its own.
        approvalAvailable: false,
        confirmable: false,
        confirmLargeGrant: false,
        reason,
        attemptedAction: 'user.bulk.credits_adjusted',
      },
      writeAudit
    );
    if (result.outcome === 'immediate') return { allowed: true, release: result.release };
    return { allowed: false, message: result.outcome === 'refused' ? result.refusal.message : 'Needs approval.' };
  };
