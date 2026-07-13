import { setupSpecUser } from './helpers/spec-setup';
import { apiEnableDataLakes } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

/**
 * Data Lakes are gated by the admin-level `EnableDataLakes` setting (default off), so every
 * `/api/data-lakes/*` endpoint 403s until it's turned on. We flip it once here using the core
 * admin token (core.setup.ts runs first via the warmup dependency), then seed the data-lake
 * spec user. The user is granted the `e2e-datalake` tag so it can hold access to a tag-gated
 * lake in the sharing/permission specs.
 *
 * Note: EnableDataLakes is a GLOBAL admin flag — enabling it affects the whole stage for the
 * duration of the run. It is left on afterwards (idempotent, and other suites don't touch it).
 */
setupSpecUser({
  key: 'dataLake',
  authFile: 'data-lake-user.json',
  tags: ['e2e-datalake'],
  afterCreate: async ({ request }) => {
    const { admin } = getTestUsers();
    await apiEnableDataLakes(request, admin.accessToken);
  },
});
