import { test, expect } from './fixtures';
import type { Page, Response } from '@playwright/test';
import { TIMEOUTS } from './constants';
import { isStagingEnv } from './helpers/env';
import { checkoutUsdAmountPattern } from './helpers/checkout-currency';
import type { TeamsPage } from './pages/TeamsPage';

/**
 * Team purchase through Stripe checkout: the half of the Teams suite that needs a real Stripe team
 * price, so it runs against staging only and skips everywhere else (previews, localhost, and
 * production, whose Stripe is live mode).
 *
 * Guards two staging regressions: team pricing failing to load from Stripe, and checkout opening in
 * the shopper's local currency instead of US dollars. Stripe's Adaptive Pricing picks the currency
 * from the shopper's IP, so the currency check only bites when run from outside the US; the
 * subscribe route's unit test is what pins `currency: 'usd'` for every run.
 *
 * Every test stops before paying except the last, which also needs STRIPE_CHECKOUT_PAY=true because
 * it leaves a test-mode Stripe subscription behind on each run. Nothing tears that down: the app has
 * no route to cancel a subscription and an org with an active one can't be deleted, so after each
 * paid run cancel the subscription in the Stripe test dashboard, then delete the `E2E Paid <id>`
 * team. Its hosted-page selectors (#cardNumber, #billingPostalCode, ...) have not been run yet.
 */
test.describe.configure({ mode: 'serial' });

const RUN_ID = Date.now().toString().slice(-6);
const SUBSCRIBE_PATH = '/api/organizations/subscriptions/subscribe';
const SUBSCRIBE_ROUTE = `**${SUBSCRIBE_PATH}`;
const STRIPE_CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;
// PHP and its peso sign, the currency staging checkout once opened in; written as an escape so the
// file stays ASCII.
const PESO = /\u20B1|\bPHP\b/;

/** The app's Teams page URL; `new URL` so a trailing slash on API_URL can't produce `//organizations`. */
const teamsUrl = (baseURL: string | undefined): string => new URL('/organizations', baseURL).href;

const isSubscribeResponse = (r: Response): boolean =>
  r.request().method() === 'POST' && new URL(r.url()).pathname === SUBSCRIBE_PATH;

/** "Total Price: $150/month" -> 150 */
async function modalTotal(teamsPage: TeamsPage): Promise<number> {
  const text = await teamsPage.createTeamPrice().innerText();
  const match = text.match(/\$([\d.]+)\/month/);
  if (!match) throw new Error(`Unexpected price text: "${text}"`);
  return Number(match[1]);
}

/**
 * Fill the Create Team modal and submit it. Returns the session the subscribe route opened and the
 * total the modal showed, once the browser has landed on Stripe's hosted page.
 */
async function startCheckout(page: Page, teamsPage: TeamsPage, teamName: string) {
  await teamsPage.gotoList();
  await teamsPage.openCreateTeam();
  await teamsPage.createTeamNameInput().fill(teamName);
  await expect(teamsPage.createTeamPrice()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  const total = await modalTotal(teamsPage);
  const seats = Number(await teamsPage.createTeamSizeInput().inputValue());

  // The app navigates to Stripe as soon as subscribe returns, and the browser drops the body of a
  // response it navigated away from, so read the body through the route instead of the page.
  let body = '';
  await page.route(SUBSCRIBE_ROUTE, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const fetched = await route.fetch();
    body = await fetched.text();
    await route.fulfill({ response: fetched, body });
  });
  const subscribed = page.waitForResponse(isSubscribeResponse, { timeout: TIMEOUTS.ACTION });
  await teamsPage.createTeamSubmit().click();
  const response = await subscribed;
  await page.unroute(SUBSCRIBE_ROUTE);
  expect(response.status(), body).toBe(200);
  const { sessionUrl }: { sessionUrl: string } = JSON.parse(body);

  await page.waitForURL(STRIPE_CHECKOUT_URL, { timeout: TIMEOUTS.ACTION });
  return { sessionUrl, total, seats };
}

test.describe('Teams - Stripe checkout (staging only)', () => {
  test.skip(!isStagingEnv(), 'Stripe checkout coverage runs on staging only');

  test('the team price loads from Stripe', async ({ page, teamsPage }) => {
    await teamsPage.gotoList();
    await teamsPage.openCreateTeam();
    await expect(teamsPage.createTeamPrice()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.createTeamPrice()).toHaveText(/Total Price: \$\d+(\.\d+)?\/month/);
    await expect(page.getByTestId('create-team-price-error')).toHaveCount(0);
  });

  test('Create Team validates the name and the seat range', async ({ page, teamsPage }) => {
    await teamsPage.gotoList();
    await teamsPage.openCreateTeam();
    await expect(teamsPage.createTeamPrice()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await expect(teamsPage.createTeamSubmit()).toBeDisabled();

    await teamsPage.createTeamNameInput().fill(`E2E Validate ${RUN_ID}`);
    await expect(teamsPage.createTeamSubmit()).toBeEnabled();

    const sizeInput = teamsPage.createTeamSizeInput();
    const min = Number(await sizeInput.getAttribute('min'));
    const max = Number(await sizeInput.getAttribute('max'));

    await sizeInput.fill(String(max + 1));
    await expect(page.getByTestId('create-team-size-value-error')).toBeVisible();
    await expect(teamsPage.createTeamSubmit()).toBeDisabled();

    await sizeInput.fill(String(min));
    await expect(page.getByTestId('create-team-size-value-error')).toHaveCount(0);
    await expect(teamsPage.createTeamSubmit()).toBeEnabled();

    // Above the flat-price floor each extra seat adds the per-seat price.
    const atMin = await modalTotal(teamsPage);
    await page.getByRole('button', { name: 'Increase team size' }).click();
    await expect(sizeInput).toHaveValue(String(min + 1));
    await expect.poll(() => modalTotal(teamsPage)).toBeGreaterThan(atMin);
  });

  test('cancel resets the Create Team modal', async ({ page, teamsPage }) => {
    await teamsPage.gotoList();
    await teamsPage.openCreateTeam();
    const sizeInput = teamsPage.createTeamSizeInput();
    await expect(sizeInput).toBeEnabled({ timeout: TIMEOUTS.VISIBLE });
    const min = await sizeInput.getAttribute('min');

    await teamsPage.createTeamNameInput().fill(`E2E Reset ${RUN_ID}`);
    await page.getByRole('button', { name: 'Increase team size' }).click();
    await page.getByTestId('create-team-cancel-btn').click();
    await expect(page.getByTestId('create-team-modal')).toBeHidden({ timeout: TIMEOUTS.MODAL });

    await teamsPage.openCreateTeam();
    await expect(teamsPage.createTeamNameInput()).toHaveValue('');
    await expect(sizeInput).toHaveValue(min ?? '');
  });

  test('checkout opens in Stripe test mode, renders, and charges in US dollars', async ({ page, teamsPage }) => {
    const { sessionUrl, total } = await startCheckout(page, teamsPage, `E2E Checkout ${RUN_ID}`);

    await test.step('the session is a test-mode Stripe checkout session', async () => {
      expect(sessionUrl).toMatch(STRIPE_CHECKOUT_URL);
      expect(sessionUrl).toContain('cs_test_');
    });

    await test.step('the hosted checkout page renders with a pay button', async () => {
      await expect(page.getByTestId('hosted-payment-submit-button')).toBeVisible({ timeout: TIMEOUTS.ACTION });
    });

    await test.step('the total matches the modal, in US dollars', async () => {
      await expect(page.getByText(checkoutUsdAmountPattern(total)).first()).toBeVisible({
        timeout: TIMEOUTS.VISIBLE,
      });
      expect(await page.locator('body').innerText()).not.toMatch(PESO);
    });
  });

  test('backing out of checkout returns to Teams without creating a team', async ({ page, teamsPage, baseURL }) => {
    const teamName = `E2E Cancelled ${RUN_ID}`;
    await startCheckout(page, teamsPage, teamName);

    // Stripe's back link is the session's cancel_url, which the modal sets to the Teams page.
    await page
      .locator(`a[href^="${teamsUrl(baseURL)}"]`)
      .first()
      .click();
    await page.waitForURL(`${teamsUrl(baseURL)}**`, { timeout: TIMEOUTS.ACTION });
    await teamsPage.dismissModals();
    await expect(page.getByTestId('organizations-create-team-btn')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
    await expect(teamsPage.teamCardByName(teamName)).toHaveCount(0);
  });

  test('paying with a Stripe test card creates the team', async ({ page, teamsPage, baseURL }) => {
    test.skip(process.env.STRIPE_CHECKOUT_PAY !== 'true', 'Set STRIPE_CHECKOUT_PAY=true to complete a payment');
    // Checkout, Stripe's redirect, then the invoice webhook that creates the org.
    test.setTimeout(TIMEOUTS.TEST * 3);

    const teamName = `E2E Paid ${RUN_ID}`;
    const { sessionUrl, seats } = await startCheckout(page, teamsPage, teamName);
    // Never put a card into anything but a test-mode session.
    expect(sessionUrl).toContain('cs_test_');

    await test.step('pay with the 4242 test card', async () => {
      await page.locator('#cardNumber').fill('4242424242424242');
      await page.locator('#cardExpiry').fill('12 / 34');
      await page.locator('#cardCvc').fill('123');
      await page.locator('#billingName').fill('E2E Teams');
      const postal = page.locator('#billingPostalCode');
      if (await postal.isVisible().catch(() => false)) await postal.fill('94103');
      await page.getByTestId('hosted-payment-submit-button').click();
      await page.waitForURL(`${teamsUrl(baseURL)}**`, { timeout: TIMEOUTS.ACTION * 2 });
    });

    await test.step('the webhook creates the team with the purchased seats', async () => {
      await expect(async () => {
        await teamsPage.gotoList();
        await expect(teamsPage.teamCardByName(teamName)).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });
      }).toPass({ timeout: TIMEOUTS.ACTION * 3 });

      await teamsPage.teamCardByName(teamName).getByTestId('organization-card-view-btn').click();
      await expect(page.getByTestId('subscription-status-card')).toContainText('Team Plan', {
        timeout: TIMEOUTS.VISIBLE,
      });
      await expect(page.getByTestId('seats-utilization-card')).toContainText(`/ ${seats}`);
    });
  });
});
