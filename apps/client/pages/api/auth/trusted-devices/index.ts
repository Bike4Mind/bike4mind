import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { trustedDeviceRepository } from '@bike4mind/database';
import { clearTrustedDeviceCookie, identifyTrustedDevice } from '@server/auth/trustedDevice';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * Self-service management of the caller's "remember this device" grants.
 *
 * GET    - list live trusts, flagging the one this request is coming from.
 * DELETE - revoke every trust ("forget all devices"). The list is always scoped to
 *          req.user.id, so one user can never see or revoke another's devices.
 */
const handler = baseApi()
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user.id;
      const [devices, current] = await Promise.all([
        trustedDeviceRepository.listByUser(userId),
        identifyTrustedDevice(req, userId),
      ]);
      return res.status(200).json({
        devices: devices.map(device => ({
          id: device.id,
          label: device.label,
          createdAt: device.createdAt,
          lastUsedAt: device.lastUsedAt ?? null,
          expiresAt: device.expiresAt,
          isCurrent: device.id === current?.id,
        })),
      });
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      const userId = req.user.id;
      const revoked = await trustedDeviceRepository.revokeAllForUser(userId);
      clearTrustedDeviceCookie(res);
      if (revoked > 0) {
        await logAuthAudit(req, { userId, event: 'trusted_device_revoked', metadata: { revoked, scope: 'all' } });
      }
      return res.status(200).json({ revoked });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
