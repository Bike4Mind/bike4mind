import { adminApi } from '@server/middlewares/adminApi';
import { coreSummary, isCoreAdmin } from '@server/tutorials/core';
import { summaryRoute } from '@server/tutorials/routes';

// Outside EnableCoreTutorials, so an admin can see what the switch would turn on.
export default summaryRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage' }, auth: 'jwtOnly' }),
  isAdmin: isCoreAdmin,
  list: coreSummary,
});
