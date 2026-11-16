import type { Request } from 'express';
import { MfaEnrollmentEvents, type IUserDocument, type MfaEnrollmentEventPayload } from '@bike4mind/common';
import { mfaService } from '@bike4mind/services';
import { readEnforceMfa } from '@bike4mind/server-utils/auth/mfaEnforcement';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import type { SignInOrigin } from '@server/auth/signInSecondFactor';

// Server half of the forced MFA enrollment funnel; the event meanings are on MfaEnrollmentEvents.

export type MfaEnrollmentSurface = NonNullable<NonNullable<MfaEnrollmentEventPayload['metadata']>['surface']>;

/** The claims on req.user that say what kind of credential made the request (verifyJwtPayload). */
type RequestCredential = { mfaPending?: unknown; impersonatedBy?: unknown; mfaSignIn?: SignInOrigin };

/**
 * Where this request's user is being made to enroll, or null when enrollment is not forced on
 * them (voluntary setup from the profile, an enrolled user, an admin impersonating). Mirrors the
 * sign-in gate (resolveSecondFactor: a pending token without a factor exists only under
 * enforcement) and the session gate (isMfaEnrollmentOwed).
 */
export async function forcedEnrollmentSurface(
  user: IUserDocument,
  credential: RequestCredential
): Promise<MfaEnrollmentSurface | null> {
  if (credential.impersonatedBy || mfaService.isMfaEnforcementExempt(user) || mfaService.userHasMFAConfigured(user)) {
    return null;
  }
  if (credential.mfaPending) return 'signin';
  return (await readEnforceMfa({ skipCache: false })) ? 'session' : null;
}

/** One funnel event. Never throws: telemetry must not fail an auth request. */
export async function recordMfaEnrollmentEvent(
  userId: string,
  type: MfaEnrollmentEvents,
  metadata: NonNullable<MfaEnrollmentEventPayload['metadata']>,
  logger?: Pick<Request['logger'], 'error'>
): Promise<void> {
  await logEvent({ userId, type, metadata }).catch(error =>
    logger?.error('MFA enrollment funnel event not recorded', error)
  );
}

/**
 * Records `type` when the request's user is in forced enrollment, with the surface and, for a
 * sign-in, the first factor it started from. Returns whether it recorded. Never throws.
 */
export async function recordForcedEnrollmentStep(
  req: Pick<Request, 'logger'> & { user?: unknown },
  user: IUserDocument,
  type: MfaEnrollmentEvents
): Promise<boolean> {
  try {
    const credential = (req.user ?? {}) as RequestCredential;
    const surface = await forcedEnrollmentSurface(user, credential);
    if (!surface) return false;
    // Read here rather than through readSignInOrigin: signInSecondFactor imports this module.
    const origin = credential.mfaSignIn;
    await recordMfaEnrollmentEvent(
      user.id,
      type,
      { surface, ...(origin && { source: origin.createdVia, strategy: origin.strategy }) },
      req.logger
    );
    return true;
  } catch (error) {
    req.logger?.error('MFA enrollment funnel step not recorded', error);
    return false;
  }
}
