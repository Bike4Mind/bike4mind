import { setupSpecUser } from './helpers/spec-setup';
import { apiCreateTestUser } from './helpers/api';
import { getTestRunId, getE2ETestId, saveSpecUser } from './helpers/test-users';
import { SKILLS_MEMBER_KEY as MEMBER_KEY } from './constants';

// Skills is ungated (no feature flag), so no extra prefs are needed - just a
// dedicated user so the spec's create/edit/delete/share never collide with
// another spec's data on a shared preview.
// Admin: the share dialog's global read/write toggles are super-admin only
// (SkillShareDialog.tsx), and skills.spec.ts exercises that flow. The non-admin
// side of the same gate needs a second, non-admin user; no project
// authenticates as it, the spec switches to it mid-test via loginAsUser.
setupSpecUser({
  key: 'skills',
  authFile: 'skills-user.json',
  isAdmin: true,
  afterCreate: async ({ request }) => {
    const ID_SUFFIX = [getE2ETestId(), getTestRunId()].filter(Boolean).join('-');
    const userConfig = {
      username: `setup-${MEMBER_KEY}-${ID_SUFFIX}`,
      email: `setup-${MEMBER_KEY}-${ID_SUFFIX}-e2e@test.com`,
      name: `Setup skills member ${ID_SUFFIX}`,
      password: `E2eSkillsMemberPass123!`,
      isAdmin: false,
    };
    const result = await apiCreateTestUser(request, userConfig);
    saveSpecUser(MEMBER_KEY, {
      userId: (result.user.id || result.user._id) as string,
      email: userConfig.email,
      password: userConfig.password,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });
  },
});
