import { adminApi } from '@server/middlewares/adminApi';
import { CORE_TUTORIAL_SETTING, isCoreAdmin } from '@server/tutorials/core';
import { settingsRoute } from '@server/tutorials/routes';

// adminApi admits delegated admins, so the full-admin check is the route's own.
export default settingsRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage', PUT: 'settings:manage' }, auth: 'jwtOnly' }),
  settingName: CORE_TUTORIAL_SETTING,
  isAdmin: isCoreAdmin,
});
