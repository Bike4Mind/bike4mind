import { z } from 'zod';
import { Permission } from '../types/entities/ShareableDocumentTypes';
import type { OrgDomainDefaultRole } from '../types/entities/OrgDomainClaimTypes';

export const ORG_DOMAIN_JOIN_POLICIES = ['off', 'suggest', 'auto-join'] as const;
export const ORG_DOMAIN_DEFAULT_ROLES = ['member', 'viewer'] as const;

/** Hard cap on domain claims (pending + verified) a single organization may hold. */
export const MAX_ORG_DOMAIN_CLAIMS = 20;

/**
 * ACL row written for a user joining through a domain claim: the same read-only row `addMember`
 * writes. 'update' on an org ACL row is org edit access (organizationService.update), so no role grants it.
 */
export const ORG_DOMAIN_ROLE_PERMISSIONS: Readonly<Record<OrgDomainDefaultRole, readonly Permission[]>> = {
  member: [Permission.read],
  viewer: [Permission.read],
};

/**
 * Bare domain (trim + lowercase, the same normalization as `normalizeSignupRuleDomain`). Public mail
 * providers pass here on purpose: the claim service rejects them so the API can say why.
 */
const orgDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Domain is required')
  .max(253, 'Domain is too long')
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a bare domain like example.com (no @ or path)');

export const addOrgDomainSchema = z.object({ domain: orgDomainSchema }).strict();

export const updateOrgDomainPolicySchema = z
  .object({
    policy: z.enum(ORG_DOMAIN_JOIN_POLICIES).optional(),
    defaultRole: z.enum(ORG_DOMAIN_DEFAULT_ROLES).optional(),
  })
  .strict()
  .refine(value => value.policy !== undefined || value.defaultRole !== undefined, {
    message: 'Nothing to update',
  });

export type AddOrgDomainInput = z.infer<typeof addOrgDomainSchema>;
export type UpdateOrgDomainPolicyInput = z.infer<typeof updateOrgDomainPolicySchema>;
