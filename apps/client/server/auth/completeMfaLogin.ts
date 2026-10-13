import type { Request, Response } from 'express';
import type { IUserDocument } from '@bike4mind/common';
import { issueBrowserSession } from '@server/auth/issueSession';
import { grantTrustedDevice, trustedDevicesAllowed } from '@server/auth/trustedDevice';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * The tail shared by every second-factor login route (TOTP/backup code and passkey): mint the
 * full session that replaces the mfaPending token, then honour "remember this device".
 * Call only after the second factor has genuinely been verified.
 */
export async function completeMfaLogin(
  // any: same reason as logAuthAudit - asyncHandler narrows the Request generics per route,
  // and only headers/socket/logger are read here.
  req: Request<any, any, any, any, any>,
  res: Response,
  user: IUserDocument,
  { rememberDevice }: { rememberDevice?: boolean }
): Promise<{ accessToken: string; deviceRemembered: boolean }> {
  const { accessToken } = await issueBrowserSession(req, res, user.id, {
    createdVia: 'mfa',
    tokenVersion: user.tokenVersion ?? 0,
  });

  // Best-effort: the login already succeeded, so a failed grant must not 500 it; the user is
  // simply challenged again next time.
  let deviceRemembered = false;
  if (rememberDevice) {
    try {
      if (await trustedDevicesAllowed()) {
        const device = await grantTrustedDevice(req, res, user.id);
        deviceRemembered = !!device;
        if (device) {
          await logAuthAudit(req, {
            userId: user.id,
            event: 'trusted_device_granted',
            metadata: { deviceId: device.id, label: device.label, expiresAt: device.expiresAt.toISOString() },
          });
        }
      }
    } catch (err) {
      req.logger?.error('Trusted-device grant failed after successful MFA verification', err);
    }
  }

  return { accessToken, deviceRemembered };
}
