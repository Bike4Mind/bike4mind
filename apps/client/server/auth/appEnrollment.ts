import { mfaService } from '@bike4mind/services';
import type { IUserDocument } from '@bike4mind/common';

export const APP_ENROLLMENT_REFUSAL = 'Complete two-step verification before adding an authenticator app.';

/**
 * True when a pre-second-factor token (mfaPending) tries to enroll an authenticator app on an
 * account that already has a factor. Sign-in enrollment exists only for accounts with none; once
 * a passkey is on, that token has proved just the password. The passkey routes hold the same rule
 * in refusePasskeyEnrollment (server/auth/passkey.ts).
 */
export function refuseAppEnrollmentBeforeSecondFactor(credential: unknown, user: IUserDocument): boolean {
  return !!(credential as { mfaPending?: unknown } | undefined)?.mfaPending && mfaService.userHasMFAConfigured(user);
}
