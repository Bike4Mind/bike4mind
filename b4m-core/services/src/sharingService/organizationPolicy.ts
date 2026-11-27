import {
  EXTERNAL_SHARING_BLOCKED,
  ForbiddenError,
  organizationAllowsRecipient,
  organizationSharingPolicy,
  PUBLIC_SHARING_BLOCKED,
  type IOrganizationDocument,
  type OrganizationShareRecipient,
} from '@bike4mind/common';

type OrganizationLookup = { findById(id: string): Promise<IOrganizationDocument | null> };

async function loadContentOrganization(organizations: OrganizationLookup, organizationId: string) {
  const org = await organizations.findById(organizationId);
  if (!org) throw new ForbiddenError('The content organization is unavailable.');
  return org;
}

/** Same rule as the database package's assertOrganizationPublicLink, for services that take an adapter. */
export async function assertContentPublicLinkPolicy(
  content: { organizationId?: string },
  organizations: OrganizationLookup
): Promise<void> {
  if (!content.organizationId) return;
  const policy = organizationSharingPolicy(await loadContentOrganization(organizations, content.organizationId));
  if (!policy.allowPublicLinks) throw new ForbiddenError(PUBLIC_SHARING_BLOCKED);
  if (!policy.allowExternalSharing) throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
}

export async function assertContentInvitePolicy(
  content: { organizationId?: string },
  recipients: OrganizationShareRecipient[],
  organizations: OrganizationLookup,
  linkOnly = false
): Promise<void> {
  if (!content.organizationId) return;
  const org = await loadContentOrganization(organizations, content.organizationId);
  const policy = organizationSharingPolicy(org);
  if (linkOnly && !policy.allowPublicLinks) throw new ForbiddenError(PUBLIC_SHARING_BLOCKED);
  if (
    (linkOnly && !policy.allowExternalSharing) ||
    recipients.some(recipient => !organizationAllowsRecipient(org, recipient))
  ) {
    throw new ForbiddenError(EXTERNAL_SHARING_BLOCKED);
  }
}
