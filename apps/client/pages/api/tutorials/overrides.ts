import { adminApi } from '@server/middlewares/adminApi';
import { CORE_TUTORIAL_CONTENT } from '@bike4mind/server-utils/tutorials/content';
import {
  coreContent,
  coreKnownSelectors,
  coreModels,
  coreOverridePolicy,
  isCoreAdmin,
} from '@bike4mind/server-utils/tutorials/core';
import { overridesRoute } from '@bike4mind/server-utils/tutorials/routes/index';

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
