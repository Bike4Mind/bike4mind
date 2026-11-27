import { adminApi } from '@server/middlewares/adminApi';
import { coreSummary, isCoreAdmin } from '@bike4mind/server-utils/tutorials/core';
import { summaryRoute } from '@bike4mind/server-utils/tutorials/routes/index';

// Outside EnableCoreTutorials, so an admin can see what the switch would turn on.
export default summaryRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage' }, auth: 'jwtOnly' }),
  isAdmin: isCoreAdmin,
  list: coreSummary,
});
