import { test as setup } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { seedAuthStorageState } from './helpers/auth-seed';
import { apiCreateTestUser, apiCreateInviteCode, apiUpdateAdminSetting } from './helpers/api';
import { saveCoreData, saveTestRunId, getE2ETestId } from './helpers/test-users';

// Marker recording whether open registration was already ON before setup, so global-teardown
// restores the prior state (and never clobbers an env where it's intentionally on).
const OPEN_REG_MARKER = path.resolve(__dirname, '.auth/open-registration-prior.json');

// Toggling allowOpenRegistration is only safe on ephemeral preview builds/localhost - on a shared
// long-lived env (staging/prod) an aborted run would leave open signup enabled, so refuse to touch it there.
const SHARED_REAL_HOSTS = ['app.staging.bike4mind.com', 'app.bike4mind.com'];
function isSharedRealEnv(apiUrl: string): boolean {
  try {
    return SHARED_REAL_HOSTS.includes(new URL(apiUrl).hostname);
  } catch {
    return false;
  }
}

const TEST_RUN_ID = Date.now().toString().slice(-8);
const E2E_ID = getE2ETestId();
const ID_SUFFIX = E2E_ID ? `${E2E_ID}-${TEST_RUN_ID}` : TEST_RUN_ID;

const ADMIN_USER = {
  username: `setup-admin-${ID_SUFFIX}`,
  email: `setup-admin-${ID_SUFFIX}-e2e@test.com`,
  name: `Setup Admin ${ID_SUFFIX}`,
  password: 'E2eAdminPass123!',
  isAdmin: true,
};

const MANAGER_USER = {
  username: `setup-manager-${ID_SUFFIX}`,
  email: `setup-manager-${ID_SUFFIX}-e2e@test.com`,
  name: `Setup Manager ${ID_SUFFIX}`,
  password: 'E2eManagerPass123!',
  isAdmin: false,
};

setup('create and authenticate admin user', async ({ page, request }) => {
  saveTestRunId(TEST_RUN_ID);

  const result = await apiCreateTestUser(request, ADMIN_USER);
  const adminId = (result.user.id || result.user._id) as string;
  const adminToken = result.accessToken;

  // Enable the Agents feature globally (admin-only setting)
  await apiUpdateAdminSetting(request, adminToken, 'EnableAgents', true);

  // Enable open registration so the signup spec can run - "Sign up" and /register are gated on
  // this and off by default in preview, so a signup failure would cascade (the `admin` project
  // depends on `unauthenticated`, i.e. auth + signup) and skip admin entirely.
  // Record the prior value; global-teardown restores it only if it was off.
  const apiUrl = process.env.API_URL || 'http://localhost:3000';
  if (isSharedRealEnv(apiUrl)) {
    console.warn(
      `[core.setup] Refusing to toggle allowOpenRegistration on shared env ${apiUrl}; ` +
        'the signup spec may be skipped. Run signup coverage against a preview build.'
    );
  } else {
    const cfgResp = await request.get(`${apiUrl}/api/settings/serverConfigPublic`);
    const openRegWasOn = cfgResp.ok() ? Boolean((await cfgResp.json()).allowOpenRegistration) : false;
    mkdirSync(path.dirname(OPEN_REG_MARKER), { recursive: true });
    writeFileSync(OPEN_REG_MARKER, JSON.stringify({ wasOn: openRegWasOn }));
    if (!openRegWasOn) {
      await apiUpdateAdminSetting(request, adminToken, 'allowOpenRegistration', true);
    }
  }

  // Create an invite code for the signup spec
  const invite = await apiCreateInviteCode(request, adminToken);

  // Create the manager user (API-only, no browser login needed)
  const managerResult = await apiCreateTestUser(request, MANAGER_USER);
  const managerId = (managerResult.user.id || managerResult.user._id) as string;
  const managerToken = managerResult.accessToken;

  saveCoreData({
    admin: {
      userId: adminId,
      email: ADMIN_USER.email,
      password: ADMIN_USER.password,
      accessToken: adminToken,
      refreshToken: result.refreshToken,
    },
    manager: {
      userId: managerId,
      email: MANAGER_USER.email,
      password: MANAGER_USER.password,
      accessToken: managerToken,
      refreshToken: managerResult.refreshToken,
    },
    inviteCode: { id: invite.id, code: invite.code },
  });

  await seedAuthStorageState(
    page,
    { accessToken: adminToken, refreshToken: result.refreshToken },
    './e2e/.auth/admin.json'
  );
});
