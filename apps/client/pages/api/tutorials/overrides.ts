import { adminApi } from '@server/middlewares/adminApi';
import { CORE_TUTORIAL_CONTENT } from '@server/tutorials/content';
import { coreContent, coreKnownSelectors, coreModels, coreOverridePolicy, isCoreAdmin } from '@server/tutorials/core';
import { overridesRoute } from '@server/tutorials/routes';

// adminApi admits delegated admins, so the full-admin check is the route's own.
export default overridesRoute({
  api: () => adminApi({ adminPermissions: { GET: 'settings:manage', PUT: 'settings:manage' }, auth: 'jwtOnly' }),
  isAdmin: isCoreAdmin,
  models: coreModels,
  content: coreContent,
  repo: CORE_TUTORIAL_CONTENT,
  policy: coreOverridePolicy,
  known: coreKnownSelectors,
});
