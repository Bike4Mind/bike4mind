import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { trustedDeviceRepository } from '@bike4mind/database';
import { clearTrustedDeviceCookie, identifyTrustedDevice } from '@server/auth/trustedDevice';
import { logAuthAudit } from '@server/utils/authAudit';
import { NotFoundError } from '@server/utils/errors';

/**
 * Revoke one "remember this device" grant. The repository scopes the delete to
 * req.user.id, so an id belonging to another account is indistinguishable from an
 * unknown one (404 either way) and can never be revoked cross-account.
 */
const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const userId = req.user.id;
    const deviceId = req.query.id!;

    // Read the current device BEFORE deleting, so revoking the device you are on also
    // drops its now-dead cookie instead of leaving the browser to present it forever.
    const current = await identifyTrustedDevice(req, userId);
    const revoked = await trustedDeviceRepository.revoke(deviceId, userId);
    if (!revoked) throw new NotFoundError('Trusted device not found');

    if (current?.id === deviceId) clearTrustedDeviceCookie(res);
    await logAuthAudit(req, { userId, event: 'trusted_device_revoked', metadata: { deviceId, scope: 'one' } });
    return res.status(200).json({ revoked: true, id: deviceId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
