import { z } from 'zod';
import { isOrgMember } from './constants/organization';
import type { IOrganizationDocument } from './types/entities/OrganizationTypes';

export const OrganizationSharingPolicySchema = z.object({
  allowPublicLinks: z.boolean(),
  allowExternalSharing: z.boolean(),
  allowedDomains: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(
          /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
          'Enter an email domain, without @ or a URL'
        )
    )
    .max(50),
});

export type OrganizationSharingPolicy = z.infer<typeof OrganizationSharingPolicySchema>;

export const DEFAULT_ORGANIZATION_SHARING_POLICY: OrganizationSharingPolicy = {
  allowPublicLinks: true,
  allowExternalSharing: true,
  allowedDomains: [],
};

export const PUBLIC_SHARING_BLOCKED = 'Your organization does not allow public links for this content.';
export const EXTERNAL_SHARING_BLOCKED =
  'Your organization only allows sharing with members and approved email domains.';

export function organizationSharingPolicy(org: {
  sharingPolicy?: OrganizationSharingPolicy;
}): OrganizationSharingPolicy {
  return { ...DEFAULT_ORGANIZATION_SHARING_POLICY, ...org.sharingPolicy };
}

export function organizationAllowsRecipient(
  org: Pick<IOrganizationDocument, 'userId' | 'users' | 'sharingPolicy'>,
  recipient: { id: string; email?: string | null }
): boolean {
  const policy = organizationSharingPolicy(org);
  if (policy.allowExternalSharing || isOrgMember({ id: recipient.id }, org)) return true;
  const domain = recipient.email?.trim().toLowerCase().split('@');
  return domain?.length === 2 && policy.allowedDomains.includes(domain[1]);
}
