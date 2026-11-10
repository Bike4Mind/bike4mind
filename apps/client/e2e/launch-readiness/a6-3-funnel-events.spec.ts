import { test, expect } from '../fixtures';
import { TIMEOUTS } from '../constants';
import { guardLaunchReadiness } from './guard';
import {
  apiUrl,
  freshIdentity,
  grantCookieConsent,
  gtagEventNames,
  recordGtagCalls,
  registerFreshAccount,
  selfReadUser,
} from './support';

guardLaunchReadiness();

const SYNTHETIC_SKIP =
  'The stage marks this test account synthetic (a syntheticUserEmailDomains entry), and synthetic accounts never send funnel events by design';

test.describe('A6.3 funnel events for a free user', () => {
  test('A6.3 starting a plan checkout fires begin_checkout', async ({ page, request, loginAsUser, basePage }) => {
    const account = await registerFreshAccount(request, freshIdentity('a63buy'));
    test.skip(Boolean((await selfReadUser(request, account)).isSynthetic), SYNTHETIC_SKIP);

    await grantCookieConsent(page);
    await recordGtagCalls(page);
    // The event fires before this request; answering it here keeps the test from opening a real checkout session.
    const apiOrigin = new URL(apiUrl()).origin;
    await page.route(
      url => url.origin === apiOrigin && url.pathname === '/api/subscriptions/subscribe',
      route => route.fulfill({ status: 503, json: { error: 'Checkout is stubbed by the launch-readiness suite' } })
    );
    await loginAsUser({ accessToken: account.accessToken, userId: account.userId });
    await page.goto('/?billing=plans');
    await basePage.dismissModals();

    await page
      .getByRole('button', { name: /^Subscribe to / })
      .first()
      .click();

    await expect.poll(() => gtagEventNames(page), { timeout: TIMEOUTS.VISIBLE }).toContain('begin_checkout');
  });

  test('A6.3 a free user hitting the plans paywall fires upsell_impression', async ({
    page,
    request,
    loginAsUser,
    basePage,
  }) => {
    const account = await registerFreshAccount(request, freshIdentity('a63upsell'));
    test.skip(Boolean((await selfReadUser(request, account)).isSynthetic), SYNTHETIC_SKIP);
    test.fail(true, 'Recorded as an expected failure until the upsell surfaces report their impressions');

    await grantCookieConsent(page);
    await recordGtagCalls(page);
    await loginAsUser({ accessToken: account.accessToken, userId: account.userId });
    await page.goto('/?billing=plans');
    await basePage.dismissModals();
    await expect(page.getByRole('button', { name: /^Subscribe to / }).first()).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });

    await expect.poll(() => gtagEventNames(page), { timeout: TIMEOUTS.VISIBLE }).toContain('upsell_impression');
  });
});
