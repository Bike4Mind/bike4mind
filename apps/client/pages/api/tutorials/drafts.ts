import { adminApi } from '@server/middlewares/adminApi';
import { isCoreAdmin } from '@bike4mind/server-utils/tutorials/core';
import { coreDraftStore } from '@bike4mind/server-utils/tutorials/coreDrafts';
import { draftsRoute } from '@bike4mind/server-utils/tutorials/routes/index';

// Outside EnableCoreTutorials, like overrides. adminApi admits delegated admins, so the full-admin check is the route's own.
export default draftsRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage', POST: 'settings:manage' }, auth: 'jwtOnly' }),
  isAdmin: isCoreAdmin,
  store: coreDraftStore,
});
