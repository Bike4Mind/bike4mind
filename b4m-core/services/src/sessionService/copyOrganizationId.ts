import { isOrgMember, type IOrganizationRepository } from '@bike4mind/common';

/**
 * The organization a session copy (clone, fork, snip) stays bound to: the source's, only while the
 * copier is a member of it; otherwise the copy is personal. Uses the same `{ id }` membership test
 * as organizationContentPolicyPlugin's create check, which would refuse a non-member's bound copy.
 */
export async function copyOrganizationId(
  organizationId: string | undefined,
  userId: string,
  organizations: Pick<IOrganizationRepository, 'findById'>
): Promise<string | undefined> {
  if (!organizationId) return undefined;
  const organization = await organizations.findById(organizationId);
  return organization && isOrgMember({ id: userId }, organization) ? organizationId : undefined;
}
