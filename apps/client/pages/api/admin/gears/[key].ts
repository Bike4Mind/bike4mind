import { canAccessAdmin } from '@bike4mind/common';
import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { GearOverride } from '@bike4mind/database';

/** DELETE /api/admin/gears/[key] - clear an override, reverting the gear to
 *  its code-defined defaults. */
const api = adminApi({
  adminPermissions: { DELETE: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
});
const handler = api.delete(async (req, res) => {
  if (!canAccessAdmin(req.user)) throw new ForbiddenError('Unauthorized. Admin access required.');
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
