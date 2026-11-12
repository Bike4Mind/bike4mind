import { isOrgMember, type IInviteDocument, type IOrganizationDocument, type IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { generateInviteLink } from '@server/managers/createDocumentInvite';

export interface OrgInviteLinkView {
  id: string;
  link: string;
  permissions: string[];
  expiresAt: Date | null;
  remaining: number;
  accepted: number;
  allowedDomains: string[];
  revokedAt: Date | null;
}

// Managers re-copy a live link from this list, so unlike the document invite list it carries the
// token-bearing URL; the route is manager-gated for that reason.
export const toOrgInviteLinkView = (invite: IInviteDocument): OrgInviteLinkView => ({
  id: invite.id,
  link: generateInviteLink(invite),
  permissions: 'permissions' in invite ? invite.permissions : [],
  expiresAt: invite.expiresAt ?? null,
  remaining: invite.remaining,
  accepted: invite.recipients?.accepted?.length ?? 0,
  allowedDomains: invite.allowedDomains ?? [],
  revokedAt: invite.revokedAt ?? null,
});

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
