import { test as setup } from '@playwright/test';
import { seedAuthStorageState } from './auth-seed';
import { apiCreateTestUser, apiUpdateUserPreferences } from './api';
import { getTestRunId, saveSpecUser, getE2ETestId } from './test-users';

interface SpecUserConfig {
  key: string;
  authFile: string;
  /** Extra user tags to seed (merged with the default predefined tags), e.g. ['tavern'] to grant Tavern access. */
  tags?: string[];
  prefs?: Record<string, unknown>;
  afterCreate?: (ctx: {
    request: import('@playwright/test').APIRequestContext;
    accessToken: string;
    userId: string;
  }) => Promise<void>;
}

export function setupSpecUser(config: SpecUserConfig) {
  setup(`create and authenticate ${config.key} test user`, async ({ page, request }) => {
    const TEST_RUN_ID = getTestRunId();
    const E2E_ID = getE2ETestId();
    const ID_SUFFIX = E2E_ID ? `${E2E_ID}-${TEST_RUN_ID}` : TEST_RUN_ID;

    const userConfig = {
      username: `setup-${config.key}-${ID_SUFFIX}`,
      email: `setup-${config.key}-${ID_SUFFIX}-e2e@test.com`,
      name: `Setup ${config.key} ${ID_SUFFIX}`,
      password: `E2e${config.key}Pass123!`,
      isAdmin: false,
      ...(config.tags && { tags: config.tags }),
    };

    const result = await apiCreateTestUser(request, userConfig);
    const id = (result.user.id || result.user._id) as string;
    const token = result.accessToken;

    if (config.prefs) {
      await apiUpdateUserPreferences(request, token, id, config.prefs);
    }

    saveSpecUser(config.key, {
      userId: id,
      email: userConfig.email,
      password: userConfig.password,
      accessToken: token,
      refreshToken: result.refreshToken,
    });

    if (config.afterCreate) {
      await config.afterCreate({ request, accessToken: token, userId: id });
    }

    await seedAuthStorageState(
      page,
      { accessToken: token, refreshToken: result.refreshToken },
      `./e2e/.auth/${config.authFile}`
    );
  });
}
