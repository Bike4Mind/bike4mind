import { IBaseRepository, IMongoDocument } from '.';
import { PaginatedResponse } from '../common';

/**
 * A partner signup rule: an admin-managed mapping from a verified email domain
 * to the entitlements and one-time signup credits any user on that domain
 * receives at email verification. Replaces the env-only
 * `NEXT_PUBLIC_PREMIUM_DOMAIN_GRANTS` config so partners can be onboarded
 * self-serve, each with independent conditions (see issue #293).
 *
 * `signupCredits` lives per-rule (not keyed on the entitlement) so partner A
 * can grant 150k while partner B grants 300k for the same entitlement - the
 * limitation the env-based `SIGNUP_CREDITS` map could not express.
 */
export interface IPartnerSignupRule {
  /** Verified-email domain, normalized lowercase (substring after the last `@`). Unique. */
  domain: string;
  /** Entitlement keys granted to a verified email on this domain. */
  entitlements: string[];
  /** One-time signup credits granted once at email verification. */
  signupCredits: number;
  /** Soft on/off without deleting the row. Disabled rules confer nothing. */
  enabled: boolean;
  /** Admin-facing display name (e.g. the partner's name). */
  label?: string;
  /** Free-form admin notes (deal reference, contact, etc.). */
  notes?: string;
  /** Admin user id who created the rule. */
  createdBy?: string;
  createdAt: Date;
  // Soft delete support (mirrors SubscriberModel).
  deletedAt?: Date | null;
}

export interface IPartnerSignupRuleDocument extends IPartnerSignupRule, IMongoDocument {}

/**
 * Repository interface for partner signup rule operations.
 */
export interface IPartnerSignupRuleRepository extends IBaseRepository<IPartnerSignupRuleDocument> {
  /** Exact (normalized) domain lookup, ignoring soft-deleted rows. */
  findByDomain: (domain: string) => Promise<IPartnerSignupRuleDocument | null>;
  /** All enabled, non-deleted rules - the set the resolution cache loads. */
  findActiveRules: () => Promise<IPartnerSignupRuleDocument[]>;
  listRules: (options: {
    page: number;
    limit: number;
    search?: string;
  }) => Promise<PaginatedResponse<IPartnerSignupRuleDocument>>;
}
