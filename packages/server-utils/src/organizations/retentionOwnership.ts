import { orgAclRowConfersMembership, type IUserDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

export async function resolveRetentionOrganization(user: IUserDocument): Promise<string | undefined> {
  if (!user.organizationId) return undefined;
  const org = await organizationRepository.findById(String(user.organizationId));
  if (!org || org.personal) return undefined;
  const member =
    org.userId === user.id || org.users.some(row => row.userId === user.id && orgAclRowConfersMembership(row));
  return member ? org.id : undefined;
}
