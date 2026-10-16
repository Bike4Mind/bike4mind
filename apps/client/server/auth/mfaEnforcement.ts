import type { IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { admitsOptionalAuthUser } from '@server/middlewares/oauthRouteGate';

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
 * Every authenticated surface calls this: the REST auth middleware (auth.ts), the optional-auth
 * shims (optionalAuth.ts, optionalJwtAuth.ts), the CLI verifier (cli/auth.ts) and the WS verifier
 * (websocket/verifyWsAccessToken.ts). An admin impersonation session (the token's impersonatedBy
 * claim) is exempt: the admin proved their own factor, and support must reach the account.
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

/**
 * The optional-auth shims' admission: admitsOptionalAuthUser plus this gate, so a session that
 * owes enrollment degrades to anonymous there instead of acting as the user. A failed settings
 * read degrades too, the less-privileged posture on a route anonymous viewers can already reach.
 */
export async function admitsOptionalAuthSession(user: unknown): Promise<boolean> {
  if (!admitsOptionalAuthUser(user)) return false;
  const session = user as IUserDocument & { impersonatedBy?: string };
  try {
    return !(await isMfaEnrollmentOwed(session, { impersonatedBy: session.impersonatedBy }));
  } catch {
    return false;
  }
}

export const MFA_ENROLLMENT_REQUIRED_MESSAGE = 'MFA enrollment required.';
