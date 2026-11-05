import { isPlaceholderValue } from '@bike4mind/common';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  accountBlockReasons,
  accountBlockedMessage,
  type AccountBlockReason,
  type AccountStateFields,
} from '@bike4mind/services/userService/accountState';

/**
 * The `/login?error=` code a redirect-based sign-in (OAuth callback) sends a blocked account to.
 * Must stay in sync with apps/client/app/utils/loginErrorMessages.ts, which renders the notice.
 */
const BLOCKED_SIGN_IN_ERROR_CODES: Record<AccountBlockReason, string> = {
  banned: 'account_suspended',
  disputePending: 'account_on_hold',
  suspended: 'account_policy_suspended',
};

/**
 * Sign-in refusal for a blocked account. A session issued to one is refused on its first request
 * (verifyJwtPayload), which the client can only read as a broken login, so sign-in refuses up
 * front and says why.
 */
export function blockedSignInErrorCode(user: AccountStateFields): string | null {
  const [reason] = accountBlockReasons(user);
  return reason ? BLOCKED_SIGN_IN_ERROR_CODES[reason] : null;
}

/** The SUPPORT_EMAIL secret, or undefined when it is unset or still the placeholder. */
export function configuredSupportEmail(): string | undefined {
  return isPlaceholderValue(Config.SUPPORT_EMAIL) ? undefined : Config.SUPPORT_EMAIL;
}

/**
 * The refusal message for a JSON sign-in response, naming the support address when one is configured.
 * Must match what the login page builds for a redirect code (withSupportContact in loginErrorMessages.ts).
 */
export function blockedSignInMessage(user: AccountStateFields): string | null {
  const message = accountBlockedMessage(user);
  if (!message) return null;
  const supportEmail = configuredSupportEmail();
  return supportEmail ? `${message} Support: ${supportEmail}` : message;
}
