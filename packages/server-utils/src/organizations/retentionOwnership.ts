import { orgAclRowConfersMembership, type IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

/** The notebook's own team org when `user` is a member of it; undefined (unbound) otherwise. */
export async function resolveRetentionOrganization(
  user: IUserDocument,
  notebookOrganizationId?: string | null
): Promise<string | undefined> {
  if (!notebookOrganizationId) return undefined;
  const org = await organizationRepository.findById(String(notebookOrganizationId));
  if (!org || org.personal) return undefined;
  const member =
    org.userId === user.id || org.users.some(row => row.userId === user.id && orgAclRowConfersMembership(row));
  return member ? org.id : undefined;
}
