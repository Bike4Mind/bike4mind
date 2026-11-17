import type { IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { requiresOrganizationMfaEnrollment } from './organizationMfa';

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

// Per instance, like the settings cache: a passed grace deadline or a policy change reaches a live
// session within one TTL. Only unenrolled users are looked up, so enrolling never waits on it.
const ORG_POLICY_CACHE_TTL_MS = 60_000;
const ORG_POLICY_CACHE_MAX_ENTRIES = 10_000;
const orgPolicyCache = new Map<string, { required: boolean; expiresAt: number }>();

async function organizationPolicyRequiresMfa(user: IUserDocument): Promise<boolean> {
  const now = Date.now();
  const cached = orgPolicyCache.get(user.id);
  if (cached && cached.expiresAt > now) return cached.required;
  const required = await requiresOrganizationMfaEnrollment(user, new Date(now));
  if (orgPolicyCache.size >= ORG_POLICY_CACHE_MAX_ENTRIES) orgPolicyCache.clear();
  orgPolicyCache.set(user.id, { required, expiresAt: now + ORG_POLICY_CACHE_TTL_MS });
  return required;
}

/**
 * Whether enforceMFA, or a team policy past its grace (requiresOrganizationMfaEnrollment), requires
 * this user to hold a factor. Exemptions are the caller's (see isMfaEnrollmentOwed).
 */
export async function isMfaEnrollmentRequired(user: IUserDocument): Promise<boolean> {
  return (await readEnforceMfa({ skipCache: false })) || (await organizationPolicyRequiresMfa(user));
}

/**
 * True when MFA is required of this user (isMfaEnrollmentRequired) and they have no factor
 * enrolled, so the session must be confined to enrollment. Binds sessions minted before the
 * requirement applied, which the sign-in gate (resolveSecondFactor) never sees. Unlike that gate
 * it does not exempt enterprise-IdP sign-ins from enforceMFA: it matches MFAEnforcementWrapper,
 * which already required enrollment of every session.
 *
 * Called from the REST auth middleware (auth.ts), the CLI verifier (cli/auth.ts), the WS verifier
 * (websocket/verifyWsAccessToken.ts), the header-JWT path of websocket/connect.ts and the
 * optional-auth shims (through admitsOptionalAuthSession in middlewares/oauthRouteGate.ts) - keep
 * them in sync, or a credential refused at one surface rides another. An admin impersonation
 * session (the token's impersonatedBy claim) is exempt: the admin proved their own factor, and
 * support must reach the account. A test persona is exempt too (mfaService.isMfaEnforcementExempt),
 * matching the `required` flag of the MFA status.
 *
 * Runs per request, so both reads are cached. An enrolled user never reaches them.
 */
export async function isMfaEnrollmentOwed(
  user: IUserDocument,
  { impersonatedBy }: { impersonatedBy?: unknown } = {}
): Promise<boolean> {
  if (impersonatedBy || mfaService.isMfaEnforcementExempt(user) || mfaService.userHasMFAConfigured(user)) {
    return false;
  }
  return isMfaEnrollmentRequired(user);
}

export const MFA_ENROLLMENT_REQUIRED_MESSAGE = 'MFA enrollment required.';
