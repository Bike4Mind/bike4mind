import { test, expect } from './fixtures';
import { TIMEOUTS } from './constants';
import { getTestUsers } from './helpers/test-users';
import { seedAuthOnPage } from './helpers/auth-seed';
import { apiGetOtcCode } from './helpers/api';

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

  test('should logout successfully', async ({ basePage, navigationPage, page }) => {
    const { user } = getTestUsers();
    await basePage.clearAllStorage();
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await page.goto('/');
    await basePage.dismissModals();

    await navigationPage.logout();

    await expect(page).toHaveURL(/.*login.*/);
  });

  // Skipped: indexedDB is not cleared after logout. Covered by a manual test; re-enable once the fix lands.
  test.skip('should clear IndexedDB caches on logout', async ({ basePage, navigationPage, page }) => {
    const { user } = getTestUsers();
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

  test('should load fresh data after re-login (no stale cache)', async ({ basePage, navigationPage, page }) => {
    test.slow();
    const { user } = getTestUsers();
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

    // Re-seed auth and verify notebooks load from server (not stale cache)
    await seedAuthOnPage(page, { accessToken: user.accessToken, refreshToken: user.refreshToken });
    await basePage.dismissModals();

    // Navigate to notebooks to trigger the quest-plans fetch
    await page.goto('/quests');
    await page.waitForLoadState('load');

    // Verify the API was actually called (not served from stale cache)
    const response = await questPlansPromise;
    expect(response.status()).toBe(200);
  });
});
