import { test as setup } from '@playwright/test';
import { seedAuthStorageState } from './helpers/auth-seed';
import { apiLoginViaOtc } from './helpers/api';
import { getTestUsers, saveCoreData } from './helpers/test-users';

// The admin project runs after `unauthenticated`, so on a full run it starts close to the 30m TTL
// of the access token core.setup.ts minted (see the caveat on buildAuthSuccessUrl in
// helpers/auth-seed.ts). Once that token expires every admin API helper answers 401 and every
// /auth/success navigation lands signed out. A second session opened here gives the admin specs a
// full TTL of their own; the first session stays valid for anything still using it.
setup('start a fresh admin session', async ({ page, request }) => {
  const { admin, manager, inviteCode } = getTestUsers();
  const tokens = await apiLoginViaOtc(request, admin.email);
  saveCoreData({ admin: { ...admin, ...tokens }, manager, inviteCode });
  await seedAuthStorageState(page, tokens, './e2e/.auth/admin.json');
});
