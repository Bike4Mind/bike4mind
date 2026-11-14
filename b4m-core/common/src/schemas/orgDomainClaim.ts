import { z } from 'zod';
import { Permission } from '../types/entities/ShareableDocumentTypes';

/** Canonical ObjectId strings at domain route and storage boundaries. */
export const orgDomainPathIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i)
  .toLowerCase();

export const ORG_DOMAIN_JOIN_POLICIES = ['off', 'suggest', 'auto-join'] as const;

/** Hard cap on domain claims (pending + verified) a single organization may hold. */
export const MAX_ORG_DOMAIN_CLAIMS = 20;

/**
 * ACL row written for a user joining through a domain claim: the same read-only row `addMember`
 * writes. 'update' on an org ACL row is org edit access (organizationService.update), so it is never granted.
 */
export const ORG_DOMAIN_MEMBER_PERMISSIONS: readonly Permission[] = [Permission.read];

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

export const updateOrgDomainPolicySchema = z.object({ policy: z.enum(ORG_DOMAIN_JOIN_POLICIES) }).strict();

export type AddOrgDomainInput = z.infer<typeof addOrgDomainSchema>;
export type UpdateOrgDomainPolicyInput = z.infer<typeof updateOrgDomainPolicySchema>;
