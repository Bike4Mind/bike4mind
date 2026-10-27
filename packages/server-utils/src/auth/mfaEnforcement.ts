import type { IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

/**
 * Schema-aware read: the stored value may be a boolean or a legacy string. Uncached by default:
 * sign-in and MFA disable must bind every instance the moment enforcement turns on, not after
 * the settings cache expires. The per-request gate opts into the cache (see isMfaEnrollmentOwed).
 */
export async function readEnforceMfa({ skipCache = true }: { skipCache?: boolean } = {}): Promise<boolean> {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache, names: ['enforceMFA'] }
  );
  return getSettingsValue('enforceMFA', settings) === true;
}

/**
 * True when the admin enforces MFA and this user has no factor enrolled, so the session must be
 * confined to enrollment. Binds sessions minted before enforcement applied, which the sign-in
 * gate (resolveSecondFactor) never sees. Unlike that gate it does not exempt enterprise-IdP
 * sign-ins: it matches MFAEnforcementWrapper, which already required enrollment of every session.
 *
 * Called from the REST auth middleware (auth.ts), the CLI verifier (cli/auth.ts), the WS verifier
 * (websocket/verifyWsAccessToken.ts) and the optional-auth shims (through admitsOptionalAuthSession
 * in middlewares/oauthRouteGate.ts) - keep those four in sync, or a credential refused at one
 * surface rides another. websocket/connect.ts is a known gap: a header JWT opens a socket there
 * with no user lookup. An admin impersonation session (the token's impersonatedBy claim) is
 * exempt: the admin proved their own factor, and support must reach the account.
 *
 * Reads the setting through the cache because it runs per request. An enrolled user never
 * reaches the read, and a toggle reaches other instances within one settings-cache TTL.
 */
export async function isMfaEnrollmentOwed(
  user: IUserDocument,
  { impersonatedBy }: { impersonatedBy?: unknown } = {}
): Promise<boolean> {
  if (impersonatedBy || mfaService.userHasMFAConfigured(user)) return false;
  return readEnforceMfa({ skipCache: false });
}

export const MFA_ENROLLMENT_REQUIRED_MESSAGE = 'MFA enrollment required.';
