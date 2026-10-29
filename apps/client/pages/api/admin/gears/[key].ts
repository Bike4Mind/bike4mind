import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { GearOverride } from '@bike4mind/database';

/** DELETE /api/admin/gears/[key] - clear an override, reverting the gear to
 *  its code-defined defaults. */
const handler = adminApi({
  adminPermissions: { DELETE: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).delete(async (req, res) => {
  const key = String(req.query.key);
  const { deletedCount } = await GearOverride.deleteOne({ key });
  if (deletedCount > 0) {
    await recordAdminActionFromRequest(req, {
      action: 'settings.gear_override.deleted',
      target: { kind: 'settings', id: key, displayName: `${key} gear override` },
      summary: `deleted gear override ${key}`,
    });
  }
  return res.status(200).json({ ok: true });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
