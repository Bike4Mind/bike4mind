import { setupSpecUser } from './helpers/spec-setup';
import { apiCreateTestUser } from './helpers/api';
import { getTestRunId, getE2ETestId, saveSpecUser } from './helpers/test-users';
import { TEAMS_INVITEE_KEY, TEAMS_MANAGER_KEY, TEAMS_MEMBER_KEY } from './constants';

// The spec user is the teams' billing OWNER and deliberately not a platform admin: an admin is
// admitted to tabs and actions the owner role alone would not reach, which would hide role bugs.
// Teams themselves are seeded per describe in the spec, through the core admin's grant endpoint.
// The member, manager and invitee are plain users the spec adds to teams and switches to mid-test.
setupSpecUser({
  key: 'teams',
  authFile: 'teams-user.json',
  afterCreate: async ({ request }) => {
    const ID_SUFFIX = [getE2ETestId(), getTestRunId()].filter(Boolean).join('-');
    for (const key of [TEAMS_MEMBER_KEY, TEAMS_MANAGER_KEY, TEAMS_INVITEE_KEY]) {
      const userConfig = {
        username: `setup-${key}-${ID_SUFFIX}`,
        email: `setup-${key}-${ID_SUFFIX}-e2e@test.com`,
        name: `Setup ${key} ${ID_SUFFIX}`,
        password: `E2e${key}Pass123!`,
        isAdmin: false,
      };
      const result = await apiCreateTestUser(request, userConfig);
      saveSpecUser(key, {
        userId: (result.user.id || result.user._id) as string,
        email: userConfig.email,
        password: userConfig.password,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      });
    }
  },
});
