import { ForbiddenError, hasAdminPermission, type AdminApproval } from '@bike4mind/common';
import { isSelfOrImpersonator } from '@bike4mind/server-utils/utils/adminAudit';
import type { CreditActor } from './delegateTargets';

/**
 * Whether an admin's credit increase to their own account or an org they belong to must wait for approval.
 * `credits:self_grant` exempts it and is not implied by full admin (EXPLICIT_ONLY_ADMIN_PERMISSIONS).
 */
export const isHeldSelfGrant = (actor: CreditActor, targetsSelf: boolean): boolean =>
  // Under impersonation `actor` is the impersonated account, whose exemption is not the impersonator's.
  targetsSelf && (actor.impersonatedBy !== undefined || !hasAdminPermission(actor, 'credits:self_grant'));

/** Approver requirement of every held self-grant: any admin holding `credits:approve_self_grant`, Super Admin or not. */
export const SELF_GRANT_APPROVAL = {
  requiredPermission: 'credits:approve_self_grant',
  requiresFullAdmin: false,
} as const;

/** Whether an approval is a held self-grant to one of `targetIds`, so executors skip the delegate target checks. */
export const isApprovedSelfGrant = (approval: AdminApproval | undefined, targetIds: readonly string[]): boolean =>
  approval?.requiredPermission === SELF_GRANT_APPROVAL.requiredPermission &&
  targetIds.some(id => id === approval.requestedBy.id || approval.requestedBy.selfIds.includes(id));

/** An approved self-grant skips the delegate target checks, so its approver must not be one of the accounts it credits. */
export function assertApproverOutsideTargets(actor: CreditActor, targetIds: readonly string[]): void {
  if (targetIds.some(id => isSelfOrImpersonator(actor, id))) {
    throw new ForbiddenError('You cannot approve credits for an organization you belong to');
  }
}
