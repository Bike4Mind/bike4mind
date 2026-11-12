import { adminApi } from '@server/middlewares/adminApi';
import { isCoreAdmin } from '@server/tutorials/core';
import { coreDraftStore } from '@server/tutorials/coreDrafts';
import { draftsRoute } from '@server/tutorials/routes';

// Outside EnableCoreTutorials, like overrides. adminApi admits delegated admins, so the full-admin check is the route's own.
export default draftsRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage', POST: 'settings:manage' }, auth: 'jwtOnly' }),
  isAdmin: isCoreAdmin,
  store: coreDraftStore,
});
