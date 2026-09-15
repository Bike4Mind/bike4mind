import { setupSpecUser } from './helpers/spec-setup';
import { apiCreateTestUser } from './helpers/api';
import { getTestRunId, getE2ETestId, saveSpecUser } from './helpers/test-users';
import { NOTEBOOK_EXPORT_IMPORTER_KEY as IMPORTER_KEY } from './constants';

/**
 * Two users: the spec user exports, and this second one imports. The round trip has to cross a
 * real ownership boundary or it proves nothing - the importer writes the decoded bytes under its
 * own userId prefix, not the exporter's.
 *
 * No project authenticates as the importer; the spec switches to it mid-test via loginAsUser.
 */
setupSpecUser({
  key: 'notebookExportBytes',
  authFile: 'notebook-export-bytes-user.json',
  afterCreate: async ({ request }) => {
    const ID_SUFFIX = [getE2ETestId(), getTestRunId()].filter(Boolean).join('-');
    const userConfig = {
      username: `setup-${IMPORTER_KEY}-${ID_SUFFIX}`,
      email: `setup-${IMPORTER_KEY}-${ID_SUFFIX}-e2e@test.com`,
      name: `Setup importer ${ID_SUFFIX}`,
      password: `E2eImporterPass123!`,
      isAdmin: false,
    };
    const result = await apiCreateTestUser(request, userConfig);
    saveSpecUser(IMPORTER_KEY, {
      userId: (result.user.id || result.user._id) as string,
      email: userConfig.email,
      password: userConfig.password,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  },
});
