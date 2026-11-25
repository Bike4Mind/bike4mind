import {
  ApiKeyStatus,
  canRevokeOrgMember,
  CreditHolderType,
  IOrganizationRepository,
  IUserDocument,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { canAdministerOrganization, isCurrentOrgMember } from './orgAuthority';

/**
 * Which of a departing member's content counts as "theirs in this org". Shared by the offboarding
 * inventory and the reassignment so the list an admin is shown is exactly what a transfer moves.
 *
 * - Files and artifacts carry `organizationId`, so they are in scope when stamped with this org.
 * - Projects, notebooks and agents have no org stamp; they are in scope only through their own share
 *   into one of the org's groups. A project's group share does not reach the notebooks or agents
 *   inside it (project grants cascade per user, not per group), so those stay with the member.
 * - Agents that carry `organizationId` are already org-owned (an agent has exactly one owner
 *   scope) and stay out: only member-owned agents move.
 *
 * `deletedAt: null` also matches documents without the field, so it is safe on every model.
 */
export interface OffboardingScope {
  organizationId: string;
  memberId: string;
  orgGroupIds: string[];
}

const inOrgGroups = (orgGroupIds: string[]) => ({ 'groups.groupId': { $in: orgGroupIds } });

export const orgStampedFilter = ({ organizationId, memberId }: OffboardingScope) => ({
  userId: memberId,
  organizationId,
  deletedAt: null,
});

/** Null when the org has no groups: nothing group-shared can be in scope, so skip the query. */
export const orgProjectFilter = ({ memberId, orgGroupIds }: OffboardingScope) =>
  orgGroupIds.length === 0 ? null : { userId: memberId, deletedAt: null, ...inOrgGroups(orgGroupIds) };

export const orgSessionFilter = ({ memberId, orgGroupIds }: OffboardingScope) =>
  orgGroupIds.length === 0 ? null : { userId: memberId, deletedAt: null, ...inOrgGroups(orgGroupIds) };

export const orgAgentFilter = ({ memberId, orgGroupIds }: OffboardingScope) =>
  orgGroupIds.length === 0
    ? null
    : { userId: memberId, organizationId: null, deletedAt: null, ...inOrgGroups(orgGroupIds) };

/**
 * Must stay in sync with UserApiKeyModel.revokeLiveOrgBilledByUserId, which revokes these on removal.
 * Embed keys (bound to an agent) are excluded: they serve the org's widget, not the member.
 */
export const orgBilledKeyFilter = ({ organizationId, memberId }: OffboardingScope) => ({
  userId: memberId,
  organizationId,
  billingOwnerType: CreditHolderType.Organization,
  status: { $ne: ApiKeyStatus.DISABLED },
  agentId: null,
});

/**
 * The same gate `revokeAccess` applies, so an admin can only inspect or move the content of a
 * member they could remove. Unknown org, no authority, or a non-member all read as not-found.
 */
export async function loadOffboardableOrganization(
  actor: IUserDocument,
  organizationId: string,
  memberId: string,
  organizations: Pick<IOrganizationRepository, 'findById'>
) {
  const organization = await organizations.findById(organizationId);
  if (!organization || !canAdministerOrganization(actor, organization)) {
    throw new NotFoundError(`Organization not found for id: ${organizationId}`);
  }
  if (organization.userId === memberId) {
    throw new BadRequestError('The organization owner cannot be offboarded; transfer ownership first.');
  }
  if (!isCurrentOrgMember(organization, memberId)) {
    throw new NotFoundError(`Organization not found for id: ${organizationId}`);
  }
  if (!canRevokeOrgMember(actor, organization, memberId)) {
    throw new ForbiddenError('Only the organization owner can offboard a manager');
  }
  return organization;
}
