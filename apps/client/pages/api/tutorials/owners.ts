import { ForbiddenError, isFullAdmin } from '@bike4mind/common';
import { premiumTutorialOwners } from '@bike4mind/server-utils/premium-generated/premiumTutorialOwners.generated';
import { adminApi } from '@server/middlewares/adminApi';

// adminApi admits delegated admins, so the full-admin check is the handler's own.
const handler = adminApi({
  adminPermissions: { GET: 'settings:manage' },
  auth: 'jwtOnly',
}).get(async (req, res) => {
  if (!isFullAdmin(req.user)) throw new ForbiddenError('Only full administrators can list tutorial owners.');
  return res.json({ owners: premiumTutorialOwners });
});

export default handler;
