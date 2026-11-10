import { z } from 'zod';

/**
 * Why an admin suspended an account, as told to the suspended user. A deliberately coarse, fixed list:
 * each entry names a terms-of-service rule the user can read, never the signal or detector that led an
 * admin to act. Stored on the user (`suspensionReasonCategory`) and echoed on the `account_suspended`
 * notice at sign-in, in the app and on the API.
 *
 * A leaf module (zod only) so the error schemas in `schemas/chat.ts` can import it without a cycle.
 * Adding a category is additive on the published `account_suspended` body; renaming or removing one is
 * a breaking API change.
 */
export const SUSPENSION_REASON_CATEGORIES = [
  'multiple_accounts',
  'automated_misuse',
  'payment_fraud',
  'prohibited_content',
  'terms_violation',
] as const;

export type SuspensionReasonCategory = (typeof SUSPENSION_REASON_CATEGORIES)[number];

export const SuspensionReasonCategorySchema = z.enum(SUSPENSION_REASON_CATEGORIES);

/** Shown when a suspension carries no category (suspended before categories existed, or by a bulk action). */
export const DEFAULT_SUSPENSION_REASON_CATEGORY: SuspensionReasonCategory = 'terms_violation';

/** The policy page a category points to; a slug on the marketing site (see `getWebsiteUrl`). */
export type SuspensionPolicy = { name: 'Terms of Service' | 'Usage Policy'; slug: 'terms-of-service' | 'usage-policy' };

const TERMS_OF_SERVICE: SuspensionPolicy = { name: 'Terms of Service', slug: 'terms-of-service' };
const USAGE_POLICY: SuspensionPolicy = { name: 'Usage Policy', slug: 'usage-policy' };

type SuspensionReasonDefinition = {
  /** The admin dialog's option label. */
  adminLabel: string;
  /** The user-facing reason, completing "Your account is suspended for ...". Lower-case, no trailing period. */
  userReason: string;
  policy: SuspensionPolicy;
};

export const SUSPENSION_REASONS: Record<SuspensionReasonCategory, SuspensionReasonDefinition> = {
  multiple_accounts: {
    adminLabel: 'Multiple accounts to obtain free credits',
    userReason: 'using multiple accounts to obtain free credits',
    policy: TERMS_OF_SERVICE,
  },
  automated_misuse: {
    adminLabel: 'Automated misuse',
    userReason: 'automated or scripted misuse of the service',
    policy: USAGE_POLICY,
  },
  payment_fraud: {
    adminLabel: 'Payment fraud',
    userReason: 'fraudulent or unauthorized payment activity',
    policy: TERMS_OF_SERVICE,
  },
  prohibited_content: {
    adminLabel: 'Prohibited content',
    userReason: 'repeated use of the service for prohibited content',
    policy: USAGE_POLICY,
  },
  terms_violation: {
    adminLabel: 'Other Terms of Service violation',
    userReason: 'a violation of our Terms of Service',
    policy: TERMS_OF_SERVICE,
  },
};

/** Narrows an untrusted value (a stored field, a `?reason=` query param) to a category, else the default. */
export function toSuspensionReasonCategory(value: unknown): SuspensionReasonCategory {
  const parsed = SuspensionReasonCategorySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SUSPENSION_REASON_CATEGORY;
}

export type SuspensionNotice = {
  category: SuspensionReasonCategory;
  /** The full sentence shown to the user: what happened, which rule, and how to appeal. */
  message: string;
  policy: SuspensionPolicy;
};

/** Where a suspended user appeals. The email wins when both are set; with neither, the notice says "contact support". */
export type SuspensionAppealContact = { email?: string | null; url?: string | null };

function appealSentence({ email, url }: SuspensionAppealContact): string {
  if (email) return `If you believe this is a mistake, you can appeal by emailing ${email}.`;
  if (url) return `If you believe this is a mistake, you can appeal at ${url}.`;
  return 'If you believe this is a mistake, you can appeal by contacting support.';
}

/**
 * The one copy of what a suspended user is told, shared by the sign-in page, the in-app redirect, the
 * API body and the optional email so they never read differently. Says which rule, never why the
 * account was flagged.
 */
export function buildSuspensionNotice(category: unknown, appeal: SuspensionAppealContact = {}): SuspensionNotice {
  const resolved = toSuspensionReasonCategory(category);
  const { userReason, policy } = SUSPENSION_REASONS[resolved];
  return {
    category: resolved,
    message: `This account is suspended for ${userReason}, which our ${policy.name} does not allow. ${appealSentence(appeal)}`,
    policy,
  };
}
