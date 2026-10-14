import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import type { IUserDocument } from '@bike4mind/common';
import { adminSettingsRepository, passkeyCredentialRepository, type ITrustedDeviceDocument } from '@bike4mind/database';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { consumeTrustedDevice, trustedDevicesAllowed } from '@server/auth/trustedDevice';
import { Config } from '@server/utils/config';
import { logAuthAudit } from '@server/utils/authAudit';

const MFA_PENDING_TOKEN_TTL = '10m';

/**
 * What a sign-in still owes after its first factor:
 * - `satisfied`: mint the full session now. `trustedDevice` is set when a remembered device
 *   skipped the challenge, for the audit trail (logSignInSuccess).
 * - `challenge`: the user has a second factor enrolled and must present it.
 * - `enroll`: the admin enforces MFA and the user has none, so they must set one up first.
 * The last two carry an mfaPending access token that only the MFA routes accept
 * (the allowlist in server/auth/auth.ts); the full session is minted by completeMfaLogin
 * or verify-setup once the factor is proven.
 */
export type SecondFactorOutcome =
  | { kind: 'satisfied'; trustedDevice: ITrustedDeviceDocument | null }
  | { kind: 'challenge'; mfaToken: string; passkeyAvailable: boolean }
  | { kind: 'enroll'; mfaToken: string };

/** Schema-aware read: the stored value may be a boolean or a legacy string. */
export async function readEnforceMfa(): Promise<boolean> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  return getSettingsValue('enforceMFA', settings) === true;
}

/**
 * Decides the second factor for a sign-in whose first factor the caller has already verified.
 * Sign-ins through an org's enterprise IdP (SAML, or Okta bound to an IdP record) do not call
 * this: the IdP owns MFA for them.
 *
 * `honourTrustedDevice: false` makes a remembered device irrelevant (emergency login).
 * A trusted device only ever skips the challenge; it never stands in for enrollment.
 */
export async function resolveSecondFactor(
  req: Pick<Request, 'headers'>,
  user: IUserDocument,
  { honourTrustedDevice = true }: { honourTrustedDevice?: boolean } = {}
): Promise<SecondFactorOutcome> {
  if (mfaService.userHasMFAConfigured(user)) {
    const trustedDevice =
      honourTrustedDevice && (await trustedDevicesAllowed()) ? await consumeTrustedDevice(req, user.id) : null;
    if (trustedDevice) return { kind: 'satisfied', trustedDevice };
    const passkeyAvailable = (await passkeyCredentialRepository.countByUser(user.id)) > 0;
    return { kind: 'challenge', mfaToken: signMfaPendingToken(user), passkeyAvailable };
  }

  if (await readEnforceMfa()) {
    return { kind: 'enroll', mfaToken: signMfaPendingToken(user) };
  }
  return { kind: 'satisfied', trustedDevice: null };
}

/** The `login_success` audit for a sign-in that minted a full session, plus `trusted_device_used`. */
export async function logSignInSuccess(
  // any: same reason as logAuthAudit - route handlers narrow the Request generics differently.
  req: Request<any, any, any, any, any>,
  {
    userId,
    strategy,
    trustedDevice,
  }: { userId: string; strategy: string; trustedDevice: ITrustedDeviceDocument | null }
): Promise<void> {
  await logAuthAudit(req, {
    userId,
    event: 'login_success',
    strategy,
    metadata: trustedDevice ? { trustedDeviceId: trustedDevice.id } : undefined,
  });
  if (!trustedDevice) return;
  await logAuthAudit(req, {
    userId,
    event: 'trusted_device_used',
    strategy,
    metadata: {
      deviceId: trustedDevice.id,
      label: trustedDevice.label,
      expiresAt: trustedDevice.expiresAt.toISOString(),
    },
  });
}

// Access token only, never a refresh token: /api/auth/refreshToken has no mfaPending check,
// so a pending refresh token would mint a full session without the second factor.
function signMfaPendingToken(user: Pick<IUserDocument, 'id' | 'tokenVersion'>): string {
  return jwt.sign({ id: user.id, mfaPending: true, tokenVersion: user.tokenVersion ?? 0 }, Config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: MFA_PENDING_TOKEN_TTL,
  });
}
