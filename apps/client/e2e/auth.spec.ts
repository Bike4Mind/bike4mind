import { type APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestUsers, getTestRunId, getE2ETestId } from './helpers/test-users';
import { seedAuthOnPage } from './helpers/auth-seed';
import { apiCreateTestUser, apiGetOtcCode, apiLoginViaOtc } from './helpers/api';

/**
 * Mint a dedicated throwaway account for a test that logs out. Logout is now per-device (issue
 * #1194): it revokes only the requesting session, not the user's other tokens. These specs still
 * use a throwaway user for clean isolation (they seed one session and log it out), which keeps the
 * teardown sweep simple - not because logout would otherwise nuke a shared user. The email mirrors
 * the setup convention (`...-<id>-e2e@test.com`) so global-teardown's cleanup sweep matches it.
 *
 * The retry index is baked into the identity: attempt 0 already created (and logged out)
 * `auth-<label>0-...`, and createUser rejects a duplicate username OR email, so without this a
 * retry would die inside apiCreateTestUser instead of re-running the test - defeating the retry
 * safety net for exactly these tests. The marker stays BEFORE the `<id>-<runId>` tail so both
 * cleanup regexes in pages/api/test/cleanup.ts still match.
 */
async function createLogoutUser(request: APIRequestContext, label: string) {
  const e2eId = getE2ETestId();
  const idSuffix = e2eId ? `${e2eId}-${getTestRunId()}` : getTestRunId();
  const slug = `auth-${label}${test.info().retry}`;
  const email = `${slug}-${idSuffix}-e2e@test.com`;
  const result = await apiCreateTestUser(request, {
    username: `${slug}-${idSuffix}`,
    email,
    name: `Auth ${label} ${idSuffix}`,
    password: `E2eAuth${label}Pass123!`,
    isAdmin: false,
  });
  return {
    email,
    userId: (result.user.id || result.user._id) as string,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  };
}

test.describe('Authentication', () => {
  test('authenticated session loads the app', async ({ basePage, page }) => {
    const { user } = getTestUsers();
    await basePage.clearAllStorage();
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await page.goto('/new');
    await basePage.dismissModals();

    // Seeded auth should keep us in the app, not bounce to /login.
    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test('logs in via the full OTC flow (email → emailed code → verify)', async ({
    basePage,
    loginPage,
    page,
    request,
  }) => {
    // Passwordless happy-path against a deployed env: email triggers /api/otc/send, code is read
    // back via the non-prod /api/test/otc-code endpoint (no mailbox). Requires E2E_CLEANUP_SECRET + non-prod stage.
    const { user } = getTestUsers();
    await basePage.clearAllStorage();
    await loginPage.goto();
    await loginPage.fillEmail(user.email); // advances to the OTC step and sends the code
    const code = await apiGetOtcCode(request, user.email);
    await loginPage.fillOtc(code);
    await loginPage.submit();
    await basePage.dismissModals();

    await expect(page).not.toHaveURL(/.*login.*/);
  });

  test('shows error on invalid OTC code', async ({ basePage, loginPage }) => {
    // Use a real existing user's email so the flow reaches the OTC step deterministically.
    const { user } = getTestUsers();
    await basePage.clearAllStorage();
    await loginPage.goto();
    await loginPage.fillEmail(user.email);
    await loginPage.fillOtc('000000');
    await loginPage.submitAndExpectFailure();

    await loginPage.expectErrorToast('Invalid code');
    await loginPage.expectLoginPage();
  });

  test('should redirect to login when accessing notebook without auth', async ({ basePage, page }) => {
    await basePage.clearAllStorage();
    await page.goto('/notebooks/67e0b7c5995108235f62b359');

    await expect(page).toHaveURL(/.*login.*/);
  });

  test('should logout successfully', async ({ basePage, navigationPage, page, request }) => {
    // Dedicated user keeps this self-contained; logout only revokes this seeded session (per-device).
    const user = await createLogoutUser(request, 'logout');
    await basePage.clearAllStorage();
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await page.goto('/');
    await basePage.dismissModals();

    await navigationPage.logout();

    await expect(page).toHaveURL(/.*login.*/);
  });

  test('logout on one device leaves other devices signed in (per-device, #1194)', async ({ request }) => {
    // Pure API-level proof of the per-device contract, independent of the browser logout UI: two
    // sessions for the SAME user, log one out, the other must survive.
    const user = await createLogoutUser(request, 'perdevice');

    // Session A is the one minted at user creation; session B is a second independent login. Reusing
    // the creation session as A keeps this to a single extra OTC round-trip (avoids OTC-send limits).
    const sessionA = { accessToken: user.accessToken, refreshToken: user.refreshToken };
    const sessionB = await apiLoginViaOtc(request, user.email);

    // Log out session A only. GET /api/logout reads the sid from A's bearer access token and
    // revokes just that session - no tokenVersion bump.
    const logoutRes = await request.get('/api/logout', {
      headers: { Authorization: `Bearer ${sessionA.accessToken}` },
    });
    expect(logoutRes.status()).toBe(200);

    // Session B's access token still authenticates - other devices stay signed in.
    const identifyB = await request.get('/api/identify', {
      headers: { Authorization: `Bearer ${sessionB.accessToken}` },
    });
    expect(identifyB.status()).toBe(200);

    // Session B can still refresh (its session is alive)...
    const refreshB = await request.post('/api/auth/refreshToken', { data: { token: sessionB.refreshToken } });
    expect(refreshB.status()).toBe(200);

    // ...while session A's refresh token is dead (its session was revoked).
    const refreshA = await request.post('/api/auth/refreshToken', { data: { token: sessionA.refreshToken } });
    expect(refreshA.status()).toBe(401);
  });

  test('log out all devices revokes every session (#1194)', async ({ request }) => {
    // The panic lever: after POST /api/users/me/sessions/logout-all, BOTH sessions must be dead.
    const user = await createLogoutUser(request, 'logoutall');
    const sessionA = { accessToken: user.accessToken, refreshToken: user.refreshToken };
    const sessionB = await apiLoginViaOtc(request, user.email);

    const res = await request.post('/api/users/me/sessions/logout-all', {
      headers: { Authorization: `Bearer ${sessionA.accessToken}` },
    });
    expect(res.status()).toBe(200);

    // tokenVersion was bumped, so even a still-unexpired access token is rejected immediately.
    const identifyB = await request.get('/api/identify', {
      headers: { Authorization: `Bearer ${sessionB.accessToken}` },
    });
    expect(identifyB.status()).toBe(401);

    // And neither session's refresh token can mint a new one.
    const refreshB = await request.post('/api/auth/refreshToken', { data: { token: sessionB.refreshToken } });
    expect(refreshB.status()).toBe(401);
  });

  // Skipped: indexedDB is not cleared after logout. Covered by a manual test; re-enable once the fix lands.
  test.skip('should clear IndexedDB caches on logout', async ({ basePage, navigationPage, page, request }) => {
    const user = await createLogoutUser(request, 'cachelogout');
    await basePage.clearAllStorage();
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await basePage.dismissModals();

    // Navigate to trigger data fetching (populates IndexedDB caches)
    await page.goto('/');
    await page.waitForLoadState('load');
    // Allow time for React Query persistence and Dexie WebSocket sync
    await page.waitForTimeout(TIMEOUTS.POST_ACTION);

    // Verify caches are populated before logout
    const cachesBefore = await page.evaluate(async () => {
      const hasReactQuery = await new Promise<boolean>(resolve => {
        const req = indexedDB.open('keyval-store');
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction('keyval', 'readonly');
            const get = tx.objectStore('keyval').get('reactQuery');
            get.onsuccess = () => resolve(get.result != null);
            get.onerror = () => resolve(false);
          } catch {
            resolve(false);
          } finally {
            db.close();
          }
        };
        req.onerror = () => resolve(false);
      });

      const hasDexie = await new Promise<boolean>(resolve => {
        const req = indexedDB.open('Bike4Mind');
        req.onsuccess = () => {
          const db = req.result;
          try {
            const storeNames = Array.from(db.objectStoreNames);
            if (storeNames.length === 0) {
              resolve(false);
              db.close();
              return;
            }
            const tx = db.transaction(storeNames, 'readonly');
            let totalCount = 0;
            let checked = 0;
            for (const name of storeNames) {
              const countReq = tx.objectStore(name).count();
              countReq.onsuccess = () => {
                totalCount += countReq.result;
                checked++;
                if (checked === storeNames.length) resolve(totalCount > 0);
              };
              countReq.onerror = () => {
                checked++;
                if (checked === storeNames.length) resolve(totalCount > 0);
              };
            }
          } catch {
            resolve(false);
          } finally {
            db.close();
          }
        };
        req.onerror = () => resolve(false);
      });

      return { hasReactQuery, hasDexie };
    });

    // At least one cache should be populated (React Query persistence or Dexie)
    const anyCachePopulated = cachesBefore.hasReactQuery || cachesBefore.hasDexie;

    console.log('Caches before logout:', cachesBefore);

    await navigationPage.logout();
    await expect(page).toHaveURL(/.*login.*/);

    // Allow time for async IDB clearing to complete
    await page.waitForTimeout(TIMEOUTS.UI_SETTLE);

    // Verify caches are cleared after logout
    const cachesAfter = await page.evaluate(async () => {
      const hasReactQuery = await new Promise<boolean>(resolve => {
        const req = indexedDB.open('keyval-store');
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction('keyval', 'readonly');
            const get = tx.objectStore('keyval').get('reactQuery');
            get.onsuccess = () => resolve(get.result != null);
            get.onerror = () => resolve(false);
          } catch {
            resolve(false);
          } finally {
            db.close();
          }
        };
        req.onerror = () => resolve(false);
      });

      const dexieRecordCount = await new Promise<number>(resolve => {
        const req = indexedDB.open('Bike4Mind');
        req.onsuccess = () => {
          const db = req.result;
          try {
            const storeNames = Array.from(db.objectStoreNames);
            if (storeNames.length === 0) {
              resolve(0);
              db.close();
              return;
            }
            const tx = db.transaction(storeNames, 'readonly');
            let totalCount = 0;
            let checked = 0;
            for (const name of storeNames) {
              const countReq = tx.objectStore(name).count();
              countReq.onsuccess = () => {
                totalCount += countReq.result;
                checked++;
                if (checked === storeNames.length) resolve(totalCount);
              };
              countReq.onerror = () => {
                checked++;
                if (checked === storeNames.length) resolve(totalCount);
              };
            }
          } catch {
            resolve(0);
          } finally {
            db.close();
          }
        };
        req.onerror = () => resolve(0);
      });

      return { hasReactQuery, dexieRecordCount };
    });

    expect(cachesAfter.hasReactQuery, 'React Query IDB cache should be cleared after logout').toBe(false);
    expect(cachesAfter.dexieRecordCount, 'Dexie tables should be empty after logout').toBe(0);

    // Confirms clearing works when caches existed; otherwise validates the post-logout state is clean.
    if (anyCachePopulated) {
      console.log('Confirmed: caches were populated before logout and cleared after.');
    }
  });

  test('should load fresh data after re-login (no stale cache)', async ({
    basePage,
    navigationPage,
    page,
    request,
  }) => {
    test.slow();
    // Dedicated user: logout revokes the seeded token, so we re-login below for a fresh one.
    const user = await createLogoutUser(request, 'relogin');
    await basePage.clearAllStorage();
    // Seed auth, navigate to populate cache, then logout
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await page.goto('/');
    await basePage.dismissModals();
    await basePage.waitForLoaderToDisappear('mfa-enforcement-loading-message');
    await basePage.waitForLoaderToDisappear('sidenav-notebooks-loading-spinner');

    await navigationPage.logout();
    await expect(page).toHaveURL(/.*login.*/);

    // Intercept the quest-plans API call to confirm it hits the server
    const questPlansPromise = page.waitForResponse(
      resp => resp.url().includes('/api/quest-plans') && resp.status() === 200,
      { timeout: TIMEOUTS.ACTION }
    );

    // Logout revoked this seeded session, so re-login for a fresh one before re-seeding -
    // otherwise /api/identify rejects the dead session's token with 401.
    const fresh = await apiLoginViaOtc(request, user.email);
    await seedAuthOnPage(page, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
    await basePage.dismissModals();

    // Navigate to notebooks to trigger the quest-plans fetch
    await page.goto('/quests');
    await page.waitForLoadState('load');

    // Verify the API was actually called (not served from stale cache)
    const response = await questPlansPromise;
    expect(response.status()).toBe(200);
  });
});
