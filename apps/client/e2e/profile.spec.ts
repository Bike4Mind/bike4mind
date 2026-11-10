import type { Browser } from '@playwright/test';
import { test, expect, openPageAs } from './fixtures';
import { BasePage } from './pages/BasePage';
import { TIMEOUTS } from './constants';
import { isGettingStarted } from '../lib/gears/tabs';
import editUserData from './fixtures/edit-user.json';
import { apiCreateThrowawayUser } from './helpers/api';
import {
  apiGetApiKeyEligibility,
  apiMintUserApiKey,
  apiMintUserApiKeySecret,
  apiReadApiKeyAccessMode,
  apiReadApiKeyTrustSettings,
  apiSetApiKeyTrust,
} from './helpers/api-keys';
import { getTestUsers } from './helpers/test-users';

const testUser = editUserData[0];

test.describe('Profile - Navigation', () => {
  test('should navigate to profile via sidenav', async ({ page, basePage }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();

    await page.getByTestId('profile-menu-card').click();
    await page.getByTestId('profile-menu-profile').click();

    await expect(page).toHaveURL(/.*\/profile.*/);
    await expect(page.getByTestId('profile-tab')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  });
});

test.describe.serial('Profile - Settings', () => {
  test('should update and revert profile settings', async ({ profilePage }) => {
    test.slow();
    await test.step('update user profile settings', async () => {
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await profilePage.fillField('Name:', testUser.newName);
      await profilePage.fillField('Team:', testUser.newTeam);
      await profilePage.fillField('Role:', testUser.newRole);
      await profilePage.fillField('Phone:', testUser.phone);
      await profilePage.selectDropdown('Preferred Contact:', testUser.preferredContactMethod);
      await profilePage.selectDropdown('T-shirt Size:', testUser.tShirtSize);

      await profilePage.saveProfile();

      // Navigate away and back to verify persistence
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await expect.poll(() => profilePage.getFieldValue('Name:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newName);
      await expect.poll(() => profilePage.getFieldValue('Team:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newTeam);
      await expect.poll(() => profilePage.getFieldValue('Role:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.newRole);
      await expect.poll(() => profilePage.getFieldValue('Phone:'), { timeout: TIMEOUTS.VISIBLE }).toBe(testUser.phone);

      const contactValue = await profilePage.getDropdownValue('Preferred Contact:');
      expect(contactValue).toBe(testUser.preferredContactMethod);
      const shirtValue = await profilePage.getDropdownValue('T-shirt Size:');
      expect(shirtValue).toBe(testUser.tShirtSize);
    });

    await test.step('revert user profile settings', async () => {
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      // Revert to original values
      await profilePage.fillField('Name:', testUser.originalName);
      await profilePage.fillField('Team:', '');
      await profilePage.fillField('Role:', '');
      await profilePage.fillField('Phone:', '');
      await profilePage.selectDropdown('Preferred Contact:', 'None');
      await profilePage.selectDropdown('T-shirt Size:', 'None');

      await profilePage.saveProfile();

      // Navigate away and back to verify persistence
      await profilePage.gotoProfile();
      await profilePage.clickEditProfile();

      await expect
        .poll(() => profilePage.getFieldValue('Name:'), { timeout: TIMEOUTS.AI_RESPONSE })
        .toBe(testUser.originalName);
      await expect.poll(() => profilePage.getFieldValue('Team:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
      await expect.poll(() => profilePage.getFieldValue('Role:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
      await expect.poll(() => profilePage.getFieldValue('Phone:'), { timeout: TIMEOUTS.VISIBLE }).toBe('');
    });
  });

  test('should verify profile page elements', async ({ profilePage }) => {
    await profilePage.gotoProfile();

    await expect(profilePage.page.getByTestId('profile-edit-btn')).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });

    const tabList = profilePage.page.getByTestId('profile-tablist');
    await expect(tabList).toBeVisible({ timeout: TIMEOUTS.VISIBLE });

    await expect(profilePage.page.getByTestId('profile-tab')).toBeVisible();
    await expect(profilePage.page.getByTestId('settings-tab')).toBeVisible();
    await expect(profilePage.page.getByTestId('community-tab')).toBeVisible();
  });

  test('should toggle experimental features', async ({ profilePage }) => {
    await profilePage.gotoProfile();
    await profilePage.clickTab('Settings');
    await profilePage.waitForFeaturesLoaded();

    // Use Research Mode - it is never admin-gated (disabled={false} hardcoded)
    const featureName = 'Research Mode';

    // Skip if somehow disabled by admin
    const isDisabled = await profilePage.isFeatureDisabledByAdmin(featureName);
    if (isDisabled) {
      test.skip(true, `${featureName} is disabled by administrator`);
      return;
    }

    const initialState = await profilePage.isFeatureEnabled(featureName);

    await profilePage.toggleFeature(featureName);
    const toggledState = await profilePage.isFeatureEnabled(featureName);
    expect(toggledState).toBe(!initialState);

    // Toggle back to restore original state
    await profilePage.toggleFeature(featureName);
    const restoredState = await profilePage.isFeatureEnabled(featureName);
    expect(restoredState).toBe(initialState);
  });
});

test.describe('Profile - Storage breakdown', () => {
  test('a new account opens the breakdown and sees no stored files', async ({ profilePage }) => {
    const { page } = profilePage;
    await profilePage.gotoProfile();

    const breakdownResponse = page.waitForResponse(
      r => r.url().includes('/api/users/me/storage-breakdown') && r.request().method() === 'GET'
    );
    await page.getByTestId('storage-breakdown-toggle-btn').click();
    const response = await breakdownResponse;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ totalBytes: 0, unaccountedBytes: 0, buckets: [] });

    await expect(page.getByTestId('storage-breakdown-empty')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });
});

test.describe('Profile - Agent connect', () => {
  test('should copy a key-free agent prompt and MCP snippets from the API Keys tab', async ({
    profilePage,
    context,
  }) => {
    const { page } = profilePage;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await profilePage.gotoProfile();
    await profilePage.clickTab('API-keys');

    await expect(page.getByTestId('agent-connect-section')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    const origin = new URL(page.url()).origin;
    const readClipboard = () => page.evaluate(() => navigator.clipboard.readText());

    await page.getByTestId('agent-connect-copy-prompt-btn').click();
    await expect.poll(readClipboard, { timeout: TIMEOUTS.ELEMENT_STATE }).toContain(`${origin}/llms.txt`);
    const prompt = await readClipboard();
    expect(prompt).toContain(`${origin}/api/v1/openapi.json`);
    expect(prompt).toContain(`${origin}/api/v1/docs`);
    expect(prompt).not.toContain('b4m_live_');

    for (const id of ['claude-code', 'codex']) {
      await page.getByTestId(`agent-connect-copy-${id}-btn`).click();
      const expected = await page.getByTestId(`agent-connect-snippet-${id}`).locator('pre').innerText();
      await expect.poll(readClipboard, { timeout: TIMEOUTS.ELEMENT_STATE }).toBe(expected);
      expect(expected).not.toContain('b4m_live_');
    }

    await expect(page.getByTestId('agent-connect-cursor-install-link')).toHaveAttribute(
      'href',
      /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=bike4mind&config=/
    );
  });

  test('should list provider keys after account keys and send spend to the Usage tab', async ({ profilePage }) => {
    const { page } = profilePage;
    await profilePage.gotoProfile();
    await profilePage.clickTab('API-keys');

    const usageLink = page.getByTestId('api-keys-usage-link');
    const agentConnect = page.getByTestId('agent-connect-section');
    const firstProvider = page.locator('[data-testid^="api-keys-provider-"]').first();
    await expect(firstProvider).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(usageLink).toBeVisible();

    const linkHandle = await usageLink.elementHandle();
    const connectHandle = await agentConnect.elementHandle();
    const providerHandle = await firstProvider.elementHandle();
    const precedes = (a: typeof linkHandle, b: typeof linkHandle) =>
      page.evaluate(([x, y]) => !!(x!.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING), [a, b]);
    expect(await precedes(linkHandle, connectHandle)).toBe(true);
    expect(await precedes(connectHandle, providerHandle)).toBe(true);
    await expect(page.getByTestId('usage-dashboard')).toHaveCount(0);

    await page.getByTestId('api-keys-usage-link-btn').click();
    await expect(page.getByTestId('usage-tab')).toHaveAttribute('aria-selected', 'true', {
      timeout: TIMEOUTS.ELEMENT_STATE,
    });
    await expect(page).toHaveURL(/tab=usage/);
    await expect(page.getByTestId('usage-spend-breakdown')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(page.getByTestId('usage-dashboard')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  });

  test('should serve llms.txt with an Authentication section', async ({ request }) => {
    const res = await request.get('/llms.txt');
    expect(res.ok()).toBe(true);
    const body = await res.text();
    expect(body).toContain('## Authentication');
    expect(body).toContain('B4M_API_KEY');
  });
});

// Every test here mints keys as a throwaway account of its own: the trust cap counts keys per owner,
// and a key on the spec user would unlock a gear and break the Sidenav - Gears test below.
test.describe('Profile - API key gates', () => {
  // installWafBypass adds its header with page.route, which cannot see a request the service worker
  // answers; without the header the edge refuses CI runners on /api/user-api-keys/*.
  test.use({ serviceWorkers: 'block' });
  const KEY_ACCESS_DENIED = 'API keys require an active paid subscription';
  // formatRateLimitReset: whole seconds under a minute, "1m" for a window that has just opened.
  const RESETS_IN = '(?:[1-5]?\\ds|1m)';

  /**
   * The admin profile's Keys tab for `userId`, in a context of its own signed in as the core admin.
   * `refresh` re-navigates rather than reloading: a reload replays the /auth/success hop and lands on home.
   */
  async function openAdminKeysTab(browser: Browser, baseURL: string | undefined, userId: string) {
    const { admin } = getTestUsers();
    const session = await openPageAs(browser, baseURL, { accessToken: admin.accessToken, userId: admin.userId });
    const refresh = async () => {
      await session.page.goto(`/admin/users/${userId}?tab=keys`);
      await new BasePage(session.page).dismissModals();
      await expect(session.page.getByTestId('user-profile-api-keys')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    };
    await refresh();
    return { ...session, refresh };
  }

  test('trust gate caps an untrusted account at its key limit until an admin approves it', async ({
    request,
    profilePage,
    loginAsUser,
  }) => {
    const { page } = profilePage;
    const { admin } = getTestUsers();
    const trust = await apiReadApiKeyTrustSettings(request, admin.accessToken);
    test.skip(!trust.gateEnabled, 'apiKeyTrustGateEnabled is off on this environment');
    test.skip(
      trust.accountAgeTrustsKeys && trust.minAccountAgeDays === 0,
      'apiKeyMinAccountAgeDays 0 trusts every account by age'
    );
    const cap = trust.maxActiveKeysUntrusted;

    // Predefined tags include Developer, which bypasses the access switch, so only trust decides here.
    const owner = await apiCreateThrowawayUser(request, 'keytrust');
    expect((await apiGetApiKeyEligibility(request, owner.accessToken)).canCreate).toBe(cap > 0);

    await test.step('fill the untrusted cap, the last key through the UI', async () => {
      for (let i = 1; i < cap; i++) {
        await apiMintUserApiKeySecret(request, owner.accessToken, {
          name: `E2E trust ${i}`,
          scopes: ['notebooks:read'],
        });
      }
      await loginAsUser(owner);
      await profilePage.gotoApiKeys();
      if (cap > 0) {
        await expect(page.getByTestId('api-keys-create-btn')).toBeEnabled();
        expect((await profilePage.createApiKeyInUi(`E2E trust ${cap}`)).status()).toBe(201);
      }
    });

    const blocked = await apiGetApiKeyEligibility(request, owner.accessToken);
    await test.step('the next key is refused, in the UI and by the mint route', async () => {
      expect(blocked.canCreate).toBe(false);
      expect(blocked.message).toMatch(
        cap > 0
          ? new RegExp(`^(New|Free) accounts may hold ${cap} active API keys?\\. To create more, purchase credits`)
          : /^(New|Free) accounts cannot create API keys yet\./
      );
      await profilePage.gotoApiKeys();
      await expect(page.getByTestId('api-keys-create-btn')).toBeDisabled();
      await expect(page.getByTestId('api-keys-gate-notice')).toHaveText(blocked.message!);

      const refused = await apiMintUserApiKey(request, owner.accessToken, {
        name: 'E2E over cap',
        scopes: ['notebooks:read'],
      });
      expect(refused.status()).toBe(403);
      expect(await refused.json()).toMatchObject({
        errorCode: 'api_key_trust_required',
        trustReason: trust.accountAgeTrustsKeys ? 'not_yet_trusted' : 'paid_standing_required',
        maxActiveKeys: cap,
        error: blocked.message,
      });
    });

    await test.step('admin approval lifts the cap', async () => {
      await apiSetApiKeyTrust(request, admin.accessToken, owner.userId, true);
      expect(await apiGetApiKeyEligibility(request, owner.accessToken)).toMatchObject({
        canCreate: true,
        message: null,
      });
      await profilePage.gotoApiKeys();
      await expect(page.getByTestId('api-keys-create-btn')).toBeEnabled();
      await expect(page.getByTestId('api-keys-gate-notice')).toHaveCount(0);
      const minted = await apiMintUserApiKey(request, owner.accessToken, {
        name: 'E2E approved',
        scopes: ['notebooks:read'],
      });
      expect(minted.status()).toBe(201);
    });
  });

  test('trust gate refuses any key until the email is verified', async ({ request, profilePage, loginAsUser }) => {
    const { page } = profilePage;
    const trust = await apiReadApiKeyTrustSettings(request, getTestUsers().admin.accessToken);
    test.skip(!trust.gateEnabled, 'apiKeyTrustGateEnabled is off on this environment');

    const owner = await apiCreateThrowawayUser(request, 'keyunverified', { emailVerified: false });
    const message = 'Verify your email address to create API keys.';
    expect(await apiGetApiKeyEligibility(request, owner.accessToken)).toMatchObject({ canCreate: false, message });

    const refused = await apiMintUserApiKey(request, owner.accessToken, {
      name: 'E2E unverified',
      scopes: ['notebooks:read'],
    });
    expect(refused.status()).toBe(403);
    expect(await refused.json()).toMatchObject({
      errorCode: 'api_key_trust_required',
      trustReason: 'email_unverified',
    });

    await loginAsUser(owner);
    // The unverified-email banner sits over the profile tabs; its dismissal persists in localStorage.
    const banner = page.getByTestId('email-verification-banner');
    await expect(banner).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await page.getByTestId('email-verification-banner-dismiss-btn').click();
    await expect(banner).toBeHidden({ timeout: TIMEOUTS.ELEMENT_STATE });
    await profilePage.gotoApiKeys();
    await expect(page.getByTestId('api-keys-create-btn')).toBeDisabled();
    await expect(page.getByTestId('api-keys-gate-notice')).toHaveText(message);
  });

  // Asserts the switch at whatever position the environment holds instead of flipping it: previews share
  // one settings database, so a flip would change key access for every preview and tester at once.
  test('access switch admits a free account only as its mode allows, and a granted plan as paid', async ({
    browser,
    baseURL,
    request,
    profilePage,
    loginAsUser,
  }) => {
    test.slow();
    const { page } = profilePage;
    const mode = await apiReadApiKeyAccessMode(request, getTestUsers().admin.accessToken);
    // No predefined tags (Developer bypasses the switch) and trust-approved, so only the switch decides.
    const owner = await apiCreateThrowawayUser(request, 'keyswitch', {
      includePredefinedTags: false,
      apiKeyTrustApproved: true,
    });
    const admin = await openAdminKeysTab(browser, baseURL, owner.userId);

    const expectSwitch = async (paid: boolean) => {
      const allowed = mode === 'all' || (mode === 'paid' && paid);
      // Polled: a fresh grant can take a moment to show in the active-subscription read.
      await expect
        .poll(() => apiGetApiKeyEligibility(request, owner.accessToken), { timeout: TIMEOUTS.ACTION })
        .toMatchObject(allowed ? { canCreate: true, message: null } : { canCreate: false, message: KEY_ACCESS_DENIED });

      await profilePage.gotoApiKeys();
      if (allowed) {
        await expect(page.getByTestId('api-keys-create-btn')).toBeEnabled();
        await expect(page.getByTestId('api-keys-gate-notice')).toHaveCount(0);
      } else {
        await expect(page.getByTestId('api-keys-create-btn')).toBeDisabled();
        await expect(page.getByTestId('api-keys-gate-notice')).toHaveText(KEY_ACCESS_DENIED);
        const refused = await apiMintUserApiKey(request, owner.accessToken, {
          name: 'E2E refused',
          scopes: ['notebooks:read'],
        });
        expect(refused.status()).toBe(403);
        expect((await refused.json()).error).toBe(KEY_ACCESS_DENIED);
      }

      // describeKeyAccess (admin/Users/Profile/tabs/keys/apiKeysModel.ts) wording for each basis this account can get.
      const basisText =
        mode === 'all'
          ? /open to every user/
          : mode === 'disabled'
            ? /turned off for everyone/
            : paid
              ? /active paid subscription/
              : /has neither/;
      await admin.refresh();
      await expect(admin.page.getByTestId('user-keys-access-chip')).toHaveText(allowed ? 'Allowed' : 'Blocked', {
        timeout: TIMEOUTS.VISIBLE,
      });
      await expect(admin.page.getByTestId('user-keys-access')).toContainText(basisText);
    };

    try {
      await loginAsUser(owner);
      await test.step(`free account under apiKeyAccess=${mode}`, () => expectSwitch(false));

      await test.step('admin grants an individual plan', async () => {
        await admin.page.getByTestId('user-profile-more-btn').click();
        await admin.page.getByTestId('user-profile-menu-subscription-item').click();
        await expect(admin.page.getByTestId('grant-subscription-dialog')).toBeVisible({ timeout: TIMEOUTS.MODAL });
        const planSelect = admin.page.getByTestId('grant-subscription-plan-select');
        // Disabled when Stripe lists no active plan price on this environment.
        test.skip(await planSelect.isDisabled(), 'no active individual plan to grant on this environment');
        await planSelect.click();
        // getByRole kept: Joy renders the options in a portal outside the select.
        await admin.page.getByRole('option').first().click();
        await admin.page.getByTestId('grant-subscription-reason-input-preset-0').click();
        const granted = admin.page.waitForResponse(
          r =>
            r.url().includes(`/api/admin/users/${owner.userId}/grant-subscription`) && r.request().method() === 'POST'
        );
        await admin.page.getByTestId('grant-subscription-dialog-confirm-btn').click();
        const response = await granted;
        test.skip(response.status() === 202, 'credit-grant approvals hold the grant for a second admin');
        expect(response.status()).toBe(200);
        await expect(admin.page.getByTestId('grant-subscription-dialog')).toBeHidden({ timeout: TIMEOUTS.ACTION });
      });

      await test.step(`paid account under apiKeyAccess=${mode}`, async () => {
        await expectSwitch(true);
        if (mode !== 'disabled') {
          const minted = await apiMintUserApiKey(request, owner.accessToken, {
            name: 'E2E paid',
            scopes: ['notebooks:read'],
          });
          expect(minted.status()).toBe(201);
        }
      });
    } finally {
      await admin.close();
    }
  });

  test('Scopes docs list the routes a key with that scope can call', async ({ request, profilePage, loginAsUser }) => {
    const { page } = profilePage;
    const scope = 'notebooks:read';
    const owner = await apiCreateThrowawayUser(request, 'keyscopes', { apiKeyTrustApproved: true });

    await loginAsUser(owner);
    await profilePage.gotoApiKeyScopesDocs();
    await expect(page.getByTestId('api-keys-scopes-open-endpoints')).toContainText('GET /api/sessions');

    const expandRoutes = async (value: string) => {
      const toggle = page.getByTestId(`api-keys-scope-endpoints-${value}-toggle-btn`);
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      return page.getByTestId(`api-keys-scope-endpoints-${value}-list`).locator('li').allInnerTexts();
    };

    const toggle = page.getByTestId(`api-keys-scope-endpoints-${scope}-toggle-btn`);
    const total = Number((await toggle.innerText()).match(/^Show all (\d+)$/)?.[1]);
    expect(total, 'toggle reads "Show all <n>"').toBeGreaterThan(1);
    const routes = await expandRoutes(scope);
    expect(routes).toHaveLength(total);
    for (const route of routes) expect(route).toMatch(/^[A-Z|]+ \/api\/\S+$/);
    await expect(toggle).toHaveText('Hide routes');

    const otherScopeRoute = 'GET /api/projects';
    expect(routes).not.toContain(otherScopeRoute);
    expect(await expandRoutes('projects:read')).toContain(otherScopeRoute);

    // The list is derived from each route's own scope check, so every route it names must let a key holding
    // only this scope through; a route listed under another scope must not. Param-free GETs only, so the
    // calls need no fixture data (a 400 for a missing query still means the scope check passed).
    const key = await apiMintUserApiKeySecret(request, owner.accessToken, { name: 'E2E scope docs', scopes: [scope] });
    const call = (path: string) => request.get(path, { headers: { Authorization: `Bearer ${key}` } });
    const callable = routes.filter(route => route.startsWith('GET ') && !route.includes(':')).map(r => r.slice(4));
    expect(callable).toContain('/api/v1/sessions');
    for (const path of [...callable, '/api/sessions']) {
      const response = await call(path);
      expect(response.status(), `${path}: ${await response.text()}`).not.toBe(403);
      expect(response.status(), path).toBeLessThan(500);
    }
    const outOfScope = await call('/api/projects');
    expect(outOfScope.status()).toBe(403);
    expect((await outOfScope.json()).required_scopes).toContain('projects:read');
  });

  test('minute window shows live usage on Security and an At limit chip on the admin profile', async ({
    browser,
    baseURL,
    request,
    profilePage,
    loginAsUser,
  }) => {
    test.slow();
    const { page } = profilePage;
    const perMinute = 2;
    const owner = await apiCreateThrowawayUser(request, 'keyminute', { apiKeyTrustApproved: true });
    const key = await apiMintUserApiKeySecret(request, owner.accessToken, {
      name: 'E2E minute window',
      scopes: ['notebooks:read'],
      rateLimit: { requestsPerMinute: perMinute, requestsPerDay: 1000 },
    });

    // Spends the minute window. A refused request is not counted, so the readout is `perMinute / perMinute`
    // however many calls this takes. Re-run inside each toPass: the fixed window can close between the
    // calls and a slow page render.
    const exhaustMinute = async () => {
      const statuses: number[] = [];
      for (let i = 0; i <= perMinute && statuses.at(-1) !== 429; i++) {
        statuses.push((await request.get('/api/sessions', { headers: { Authorization: `Bearer ${key}` } })).status());
      }
      expect(statuses.at(-1), `statuses ${statuses.join(',')}`).toBe(429);
      expect(
        statuses.slice(0, -1).every(s => s === 200),
        `statuses ${statuses.join(',')}`
      ).toBe(true);
    };

    await loginAsUser(owner);
    await test.step('Profile > Security reads the live minute window', async () => {
      await expect(async () => {
        await exhaustMinute();
        await profilePage.gotoProfile();
        await profilePage.clickTab('Security');
        await expect(page.getByTestId('api-key-usage-minute-0')).toHaveText(
          new RegExp(`^This minute: ${perMinute} / ${perMinute} requests \u00b7 resets in ${RESETS_IN}$`),
          { timeout: TIMEOUTS.VISIBLE }
        );
      }).toPass({ timeout: TIMEOUTS.ACTION * 3 });
      await expect(page.getByTestId('api-key-usage-day-0')).toHaveText(/^Today: \d+ \/ 1,000 requests/);
    });

    const admin = await openAdminKeysTab(browser, baseURL, owner.userId);
    try {
      await test.step('admin profile flags the key At limit with its reset time', async () => {
        const chip = admin.page.getByTestId('user-keys-live-limit');
        await expect(async () => {
          await exhaustMinute();
          await admin.refresh();
          await expect(chip).toHaveText('At limit', { timeout: TIMEOUTS.VISIBLE });
          // Joy opens a tooltip on focus only when focus is keyboard-visible, so hover instead.
          await chip.hover();
          // getByRole kept: Joy renders the tooltip in a portal outside the chip.
          await expect(admin.page.getByRole('tooltip')).toHaveText(
            new RegExp(`^Per-minute limit reached \\(${perMinute}/${perMinute}\\); resets in ${RESETS_IN}\\.$`),
            { timeout: TIMEOUTS.ELEMENT_STATE }
          );
        }).toPass({ timeout: TIMEOUTS.ACTION * 3 });
      });
    } finally {
      await admin.close();
    }
  });
});

// Relies on this spec user having no claimable gear: anything here that unlocks one
// (e.g. creating an API key) swaps the Start here tag for Claim and breaks this test.
test.describe('Sidenav - Gears', () => {
  test('new account sees the Getting Started reward on the Gears row', async ({ page, basePage }) => {
    const statusResponse = page.waitForResponse(r => r.url().includes('/api/gears/status') && r.ok());
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
    const { gears } = (await (await statusResponse).json()) as {
      gears: { key: string; kind: 'destination' | 'skill'; credits: number; unlocked: boolean; claimed?: boolean }[];
    };
    // Upper bound only: feature flags can hide a Getting Started gear from the sum.
    const undoneCredits = gears
      .filter(g => isGettingStarted(g) && !g.unlocked && !g.claimed)
      .reduce((sum, g) => sum + g.credits, 0);

    const tag = page.getByTestId('sidenav-gears-start-here');
    await expect(tag).toHaveText(/^Start here, \+[\d.,\s\u00a0\u202f]+ credits?$/, { timeout: TIMEOUTS.VISIBLE });
    const shown = Number((await tag.textContent())!.replace(/\D/g, ''));
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(undoneCredits);
  });
});
