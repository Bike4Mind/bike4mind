import {
  EXTERNAL_SHARING_BLOCKED,
  ForbiddenError,
  organizationAllowsRecipient,
  organizationSharingPolicy,
  PUBLIC_SHARING_BLOCKED,
  type IOrganizationDocument,
} from '@bike4mind/common';

export async function assertContentInvitePolicy(
  content: { organizationId?: string },
  recipients: Array<{ id: string; email?: string | null }>,
  organizations: { findById(id: string): Promise<IOrganizationDocument | null> },
  linkOnly = false
): Promise<void> {
  if (!content.organizationId) return;
  const org = await organizations.findById(content.organizationId);
  if (!org) throw new ForbiddenError('The content organization is unavailable.');
  const policy = organizationSharingPolicy(org);
  if (linkOnly && !policy.allowPublicLinks) throw new ForbiddenError(PUBLIC_SHARING_BLOCKED);
  if (
    (linkOnly && !policy.allowExternalSharing) ||
    recipients.some(recipient => !organizationAllowsRecipient(org, recipient))
  ) {
    throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
  }
}
