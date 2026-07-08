import { z } from 'zod';

/**
 * Public mail providers that must never be configured as a partner signup rule
 * - a grant on one of these would hand paid entitlements + credits to anyone
 * with a free mailbox. Rejected on save (not exhaustive; the highest-volume
 * consumer domains). Kept lowercase for direct comparison against a normalized
 * domain.
 */
export const DISALLOWED_SIGNUP_RULE_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'zoho.com',
];

/** Normalize a domain the same way the entitlement layer does (trim + lowercase). */
export const normalizeSignupRuleDomain = (value: string): string => value.trim().toLowerCase();

/**
 * A bare email domain: at least one label, a dot, and a TLD. Rejects a leading
 * `@`, whitespace, and full email addresses - the admin enters `partner.com`,
 * not `user@partner.com`.
 */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Domain is required')
  .max(253, 'Domain is too long')
  // Each label is [a-z0-9] bounded (no leading/trailing hyphen, so `partner-.com` is rejected),
  // one or more labels, then a 2+ letter TLD. Rejects full emails, paths, and edge-hyphens.
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a bare domain like partner.com (no @ or path)')
  .refine(domain => !DISALLOWED_SIGNUP_RULE_DOMAINS.includes(domain), {
    message: 'Public mail providers (gmail.com, etc.) cannot be a partner domain',
  });

/** Entitlement key token: lowercase, matches the registry `normalizeTag` shape. */
const entitlementKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Entitlement key cannot be empty')
  .max(128, 'Entitlement key is too long');

// Shared field schemas so create and update validate identically (DRY) without
// the update path inheriting create's defaults.
const entitlementsSchema = z.array(entitlementKeySchema).max(20, 'Too many entitlements');
const signupCreditsSchema = z.number().int('Credits must be a whole number').min(0, 'Credits cannot be negative');
const labelSchema = z.string().trim().max(120);
const notesSchema = z.string().trim().max(2000);

/**
 * Create payload for a partner signup rule. `enabled` defaults to true so a
 * newly-created rule is live immediately (the common case); an admin toggles
 * it off explicitly to stage a rule.
 */
export const createPartnerSignupRuleSchema = z.object({
  domain: domainSchema,
  entitlements: entitlementsSchema,
  signupCredits: signupCreditsSchema,
  enabled: z.boolean().default(true),
  label: labelSchema.optional(),
  notes: notesSchema.optional(),
});

/**
 * Update payload - every field optional and NO defaults: an omitted field must be a
 * true no-op (a PUT changing only credits must never silently flip `enabled`). `.strict()`
 * rejects unknown keys, which also enforces that `domain` is immutable (it's the lookup key).
 */
export const updatePartnerSignupRuleSchema = z
  .object({
    entitlements: entitlementsSchema.optional(),
    signupCredits: signupCreditsSchema.optional(),
    enabled: z.boolean().optional(),
    label: labelSchema.optional(),
    notes: notesSchema.optional(),
  })
  .strict();

export type CreatePartnerSignupRuleInput = z.infer<typeof createPartnerSignupRuleSchema>;
export type UpdatePartnerSignupRuleInput = z.infer<typeof updatePartnerSignupRuleSchema>;
