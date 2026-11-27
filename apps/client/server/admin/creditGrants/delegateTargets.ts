import {
  assertCanActOnAdminTarget,
  ForbiddenError,
  isFullAdmin,
  NotFoundError,
  type AdminApproval,
} from '@bike4mind/common';
import { organizationRepository, userRepository } from '@bike4mind/database';
import { SubscriptionOwnerType, type ISubscription } from '@bike4mind/server-utils/lib/subscriptions/types';
import { isSelfOrImpersonator } from '@bike4mind/server-utils/utils/adminAudit';

export type CreditActor = Parameters<typeof isFullAdmin>[0] & { id: string; impersonatedBy?: string };
type CreditedOrganization = {
  userId?: string | null;
  adminUserIds?: readonly string[] | null;
  billingManagerUserIds?: readonly string[] | null;
  users?: readonly { userId?: string | null }[] | null;
};

/**
 * The target checks a delegated `credits:adjust` admin passes before moving credits or changing a subscription: never
 * an account with admin access (its own included, since a delegate has admin access), and never an organization the
 * delegate belongs to. Full admins skip them; their self-actions are still audited by each route as before.
 */
export async function assertDelegateCanCreditUser(actor: CreditActor, userId: string, verb: string): Promise<void> {
  if (isFullAdmin(actor)) return;
  if (isSelfOrImpersonator(actor, userId)) throw new ForbiddenError(`You cannot ${verb} your own account`);
  assertCanActOnAdminTarget(actor, await userRepository.findById(userId), verb);
}

/** Check a bulk request before any account in it is changed. */
export async function assertDelegateCanCreditUsers(actor: CreditActor, userIds: string[], verb: string): Promise<void> {
  if (isFullAdmin(actor) || userIds.length === 0) return;
  if (userIds.some(userId => isSelfOrImpersonator(actor, userId))) {
    throw new ForbiddenError(`You cannot ${verb} your own account`);
  }
  const users = await userRepository.find(
    { _id: { $in: userIds } },
    { isAdmin: 1, adminPermissions: 1, adminRoleIds: 1 }
  );
  for (const user of users) assertCanActOnAdminTarget(actor, user, verb);
}

export const organizationMemberIds = (organization: CreditedOrganization): string[] =>
  [
    organization.userId,
    ...(organization.adminUserIds ?? []),
    ...(organization.billingManagerUserIds ?? []),
    ...(organization.users ?? []).map(member => member.userId),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

/** Whether the actor (or the admin impersonating them) owns, administers, bills for or is a member of the organization. */
export function belongsToOrganization(actor: CreditActor, organization: CreditedOrganization): boolean {
  return organizationMemberIds(organization).some(id => isSelfOrImpersonator(actor, id));
}

/**
 * Whether a credit change to the organization is a self-grant: the acting admin belongs to it, or, when an
 * approver runs it, the admin who requested it does. Approval executors run as the approver.
 */
export function isOrganizationSelfGrant(
  actor: CreditActor,
  organization: CreditedOrganization,
  approval?: Pick<AdminApproval, 'requestedBy'>
): boolean {
  if (belongsToOrganization(actor, organization)) return true;
  const requesterIds = approval?.requestedBy.selfIds ?? [];
  return organizationMemberIds(organization).some(id => requesterIds.includes(id));
}

export async function assertDelegateCanCreditOrganization(
  actor: CreditActor,
  organization: CreditedOrganization,
  verb: string
): Promise<void> {
  if (isFullAdmin(actor)) return;
  if (belongsToOrganization(actor, organization)) {
    throw new ForbiddenError(`You cannot ${verb} an organization you belong to`);
  }
  if (organization.userId) await assertDelegateCanCreditUser(actor, organization.userId, verb);
}

export async function assertDelegateCanChangeSubscription(
  actor: CreditActor,
  subscription: Pick<ISubscription, 'ownerType' | 'ownerId'>,
  verb: string
): Promise<void> {
  if (isFullAdmin(actor)) return;
  if (subscription.ownerType === SubscriptionOwnerType.Organization) {
    const organization = await organizationRepository.findById(subscription.ownerId);
    if (!organization) throw new NotFoundError('Organization not found');
    await assertDelegateCanCreditOrganization(actor, organization, verb);
    return;
  }
  await assertDelegateCanCreditUser(actor, subscription.ownerId, verb);
}
