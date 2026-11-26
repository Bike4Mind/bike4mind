import { hasAdminPermission, type AdminApproval } from '@bike4mind/common';
import type { CreditActor } from './delegateTargets';

/**
 * Whether a credit increase an admin makes to their own account, or to an organization they belong to,
 * must wait for a second admin's approval. It always must unless they hold `credits:self_grant`, which the
 * full-admin flag does not imply (EXPLICIT_ONLY_ADMIN_PERMISSIONS). Delegated admins are refused such grants
 * outright (delegateTargets.ts), so this only ever holds a full admin's.
 */
export const isHeldSelfGrant = (actor: CreditActor, targetsSelf: boolean): boolean =>
  // Under impersonation `actor` is the impersonated account, whose exemption is not the impersonator's.
  targetsSelf && (actor.impersonatedBy !== undefined || !hasAdminPermission(actor, 'credits:self_grant'));

/**
 * The approver requirement every held self-grant is requested with: an admin holding `credits:approve_self_grant`,
 * Super Admin or not. A Super Admin's second account cannot approve unless it was granted that permission.
 */
export const SELF_GRANT_APPROVAL = {
  requiredPermission: 'credits:approve_self_grant',
  requiresFullAdmin: false,
} as const;

/**
 * Whether an approval being executed is a held self-grant. Its approver may be a delegate, so the executors skip
 * the delegate target checks (own account, admin-access account, own organization) that would otherwise refuse it:
 * the requester was a full admin who passed the route's checks, and approving is the control.
 */
export const isApprovedSelfGrant = (approval: AdminApproval | undefined): boolean =>
  approval?.requiredPermission === SELF_GRANT_APPROVAL.requiredPermission;
