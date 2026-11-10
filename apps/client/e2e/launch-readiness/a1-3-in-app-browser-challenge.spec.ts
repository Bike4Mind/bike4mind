import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';
import { TURNSTILE_BROWSER_REJECTED_MESSAGE } from '../../app/utils/turnstile';
import { guardLaunchReadiness } from './guard';
import { apiUrl, freshIdentity } from './support';

guardLaunchReadiness();

// Cloudflare's always-passes test site key. Only reaches the stubbed widget below, never Cloudflare.
const TEST_SITE_KEY = '1x00000000000000000000AA';

// Cloudflare decides in its own widget whether a browser looks automated, and a headless runner
// cannot make it reject an in-app browser for real. So the rejection is simulated at the widget
// boundary: the stub reports 600010, the code Cloudflare gives a browser it judges bot-like, and
// the specs check what the app does with it.
const REJECTING_WIDGET = `window.turnstile = {
  render: function (_container, options) {
    setTimeout(function () { options['error-callback']('600010'); }, 0);
    return 'lr-rejecting-widget';
  },
  remove: function () {},
};`;

const IN_APP_BROWSERS = [
  {
    name: 'Facebook on iOS',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/620195327;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]',
  },
  {
    name: 'Instagram on Android',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 Instagram 343.0.0.33.101 Android (34/14; 420dpi; 1080x2205; Google/google; Pixel 8; shiba; shiba; en_US; 628386101)',
  },
  {
    name: 'Android webview without the Mobile token',
    userAgent:
      'Mozilla/5.0 (Linux; Android 13; SM-X710 Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.134 Safari/537.36',
  },
];

/** Make the login form run a challenge even on a stage that has Turnstile switched off. */
async function requireChallenge(page: Page): Promise<void> {
  const apiOrigin = new URL(apiUrl()).origin;
  await page.route(
    url => url.origin === apiOrigin && url.pathname === '/api/settings/serverConfigPublic',
    async route => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({
        response,
        json: { ...config, turnstileSiteKey: config.turnstileSiteKey || TEST_SITE_KEY },
      });
    }
  );
}

for (const browser of IN_APP_BROWSERS) {
  test.describe(`in-app browser: ${browser.name}`, () => {
    test.use({ userAgent: browser.userAgent });

    test(`A1.3 ${browser.name} sees the open-in-your-browser message when the challenge rejects it`, async ({
      page,
      loginPage,
    }) => {
      test.slow();
      await requireChallenge(page);
      await page.route(/^https:\/\/challenges\.cloudflare\.com\/turnstile\//, route =>
        route.fulfill({ status: 200, contentType: 'application/javascript', body: REJECTING_WIDGET })
      );
      const reports: unknown[] = [];
      await page.route('**/api/turnstile/client-failure', async route => {
        reports.push(route.request().postDataJSON());
        await route.fulfill({ status: 204 });
      });

      await loginPage.goto();
      await loginPage.submitEmail(freshIdentity('a13r').email);

      await loginPage.expectErrorToast(TURNSTILE_BROWSER_REJECTED_MESSAGE);
      await expect(page.getByTestId('login-otc-input')).toBeHidden();
      await expect
        .poll(() => reports, { timeout: TIMEOUTS.VISIBLE })
        .toContainEqual(expect.objectContaining({ reason: 'error', errorCode: '600010', attempts: 3 }));
    });

    test(`A1.3 ${browser.name} reaches the code step when the challenge passes`, async ({ page, loginPage }) => {
      await requireChallenge(page);

      await loginPage.goto();
      await loginPage.submitEmail(freshIdentity('a13p').email);

      await loginPage.expectOtcStep();
    });
  });
}
