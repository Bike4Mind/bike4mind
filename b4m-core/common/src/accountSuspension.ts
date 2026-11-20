import { ACCOUNT_SUSPENDED_ERROR_CODE } from './apiErrorCodes';
import { buildSuspensionNotice, type SuspensionReasonCategory } from './accountSuspensionCategories';
import { ForbiddenError } from './errors';
import { WEBSITE_URL, getWebsiteUrl } from './utils';

/** The `suspension` member of an `account_suspended` body; documented by `AccountSuspensionDetailSchema`. */
export type AccountSuspensionDetail = {
  reason_category: SuspensionReasonCategory;
  terms_url?: string;
  appeal_url?: string;
};

/**
 * The 403 an admin-suspended account gets on every authenticated surface (session, refresh, API key,
 * WebSocket). Valid credential, refused owner: 403 + `errorCode: account_suspended` per CONVENTIONS.md,
 * so a client can tell it from an expired session and stop retrying. The body names the category and
 * where to read the rule and appeal, never the signals behind the decision.
 *
 * Links are omitted when the deployment has no WEBSITE_URL (self-host), rather than published relative.
 */
export function accountSuspendedError(category: unknown): ForbiddenError {
  const appealUrl = WEBSITE_URL ? getWebsiteUrl('support') : undefined;
  const notice = buildSuspensionNotice(category, { url: appealUrl });
  const suspension: AccountSuspensionDetail = {
    reason_category: notice.category,
    ...(WEBSITE_URL && { terms_url: getWebsiteUrl(notice.policy.slug), appeal_url: appealUrl }),
  };
  return new ForbiddenError(notice.message, { errorCode: ACCOUNT_SUSPENDED_ERROR_CODE, suspension });
}
