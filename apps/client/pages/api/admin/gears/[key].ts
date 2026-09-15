import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { GearOverride } from '@bike4mind/database';

/** DELETE /api/admin/gears/[key] - clear an override, reverting the gear to
 *  its code-defined defaults. */
const handler = baseApi().delete(async (req, res) => {
  if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
  await GearOverride.deleteOne({ key: String(req.query.key) });
  return res.status(200).json({ ok: true });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
