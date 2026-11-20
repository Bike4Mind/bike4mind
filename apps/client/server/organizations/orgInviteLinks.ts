import {
  isOrgMember,
  isOrgOwnerOrPlatformAdmin,
  roleForPermissions,
  type Permission,
  type IInviteDocument,
  type IOrganizationDocument,
  type IUserDocument,
} from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { generateInviteLink } from '@server/managers/createDocumentInvite';

export interface OrgInviteLinkView {
  id: string;
  /** null for an above-Viewer link shown to a manager who could not have minted it. */
  link: string | null;
  permissions: string[];
  expiresAt: Date | null;
  remaining: number;
  accepted: number;
  allowedDomains: string[];
  revokedAt: Date | null;
}

/**
 * A link anyone holding it can redeem, up to the link's join cap, so above Viewer it stays with the
 * owner tier: a manager may mint or re-copy only a Viewer link.
 */
export const canHandOutOrgInviteLink = (
  viewer: IUserDocument,
  organization: IOrganizationDocument,
  permissions: readonly Permission[]
): boolean => roleForPermissions(permissions) === 'viewer' || isOrgOwnerOrPlatformAdmin(viewer, organization);

// Managers re-copy a live link from this list, so unlike the document invite list it carries the
// token-bearing URL; the route is manager-gated for that reason. Only a caller who could have minted
// the link (canHandOutOrgInviteLink) gets its URL back.
export const toOrgInviteLinkView = (
  invite: IInviteDocument,
  viewer: IUserDocument,
  organization: IOrganizationDocument
): OrgInviteLinkView => {
  const permissions = 'permissions' in invite ? invite.permissions : [];
  const hideLink = !canHandOutOrgInviteLink(viewer, organization, permissions);
  return {
    id: invite.id,
    link: hideLink ? null : generateInviteLink(invite),
    permissions,
    expiresAt: invite.expiresAt ?? null,
    remaining: invite.remaining,
    accepted: invite.recipients?.accepted?.length ?? invite.accepted ?? 0,
    allowedDomains: invite.allowedDomains ?? [],
    revokedAt: invite.revokedAt ?? null,
  };
};

/** Loads the organization and applies the same disclosure guard then manage gate as bulk-invite. */
export async function loadManagedOrganization(
  user: IUserDocument,
  organizationId: string | undefined
): Promise<IOrganizationDocument> {
  if (!organizationId) throw new BadRequestError('Organization id is required');
  const organization = await organizationRepository.findById(organizationId);
  if (!organization || !isOrgMember(user, organization)) throw new NotFoundError('Organization not found');
  organizationService.assertCanManageOrgGroups(user, organization);
  return organization;
}
