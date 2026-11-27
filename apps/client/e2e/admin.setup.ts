import { test as setup } from './waf-test';
import { apiLoginViaOtc } from './helpers/api';
import { seedAuthStorageState } from './helpers/auth-seed';
import { getTestUsers, saveCoreData } from './helpers/test-users';
import { withLock } from './helpers/token-renewal';

// The admin project is the last to start, so on a full run the access token core.setup.ts minted
// (30 min, ACCESS_TOKEN_TTL_SECONDS in server/auth/tokenGenerator.ts) can run out before or during
// it: API calls then answer 401 and admin routes bounce to /login. A new sign-in right before the
// admin specs gives them a token with its full lifetime.
setup('sign the setup admin in again', async ({ page, request }) => {
  let tokens: Awaited<ReturnType<typeof apiLoginViaOtc>> | undefined;
  // Other projects may be renewing tokens into core-data.json now; take the same lock they do.
  const signIn = async () => {
    const { admin, manager, inviteCode } = getTestUsers();
    tokens = await apiLoginViaOtc(request, admin.email);
    saveCoreData({ admin: { ...admin, ...tokens }, manager, inviteCode });
  };
  if (!(await withLock('core', signIn))) await signIn();
  await seedAuthStorageState(page, tokens!, './e2e/.auth/admin.json');
});
