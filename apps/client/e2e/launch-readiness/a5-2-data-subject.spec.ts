import type { APIRequestContext } from '@playwright/test';
import { Resource } from 'sst';
import { test, expect } from '../fixtures';
import { apiCreateThrowawayUser } from '../helpers/api';
import { guardLaunchReadiness } from './guard';
import { adminToken, apiUrl } from './support';

guardLaunchReadiness();

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A request context with no cookies: the throwaway's calls then carry only its bearer token, which
 * the CSRF check exempts, instead of a refresh cookie left behind by another call in the test.
 */
async function signedInAs(
  playwright: { request: { newContext: () => Promise<APIRequestContext> } },
  account: { accessToken: string; password: string }
) {
  const context = await playwright.request.newContext();
  const stepUp = await context.post(`${apiUrl()}/api/auth/step-up`, {
    headers: bearer(account.accessToken),
    data: { method: 'password', password: account.password },
  });
  expect(stepUp.ok(), `step-up failed: ${stepUp.status()}`).toBe(true);
  return context;
}

test.describe('A5.2 data subject paths', () => {
  test('A5.2 an account can export its data', async ({ request, playwright }) => {
    test.slow();
    const account = await apiCreateThrowawayUser(request, 'lra52x');
    const context = await signedInAs(playwright, account);
    try {
      const started = await context.post(`${apiUrl()}/api/users/me/data-export`, {
        headers: bearer(account.accessToken),
      });
      expect(started.status(), await started.text()).toBe(202);
      const { exportJobId } = (await started.json()) as { exportJobId: string };

      await expect
        .poll(
          async () =>
            (
              await context.get(`${apiUrl()}/api/users/me/data-export/${exportJobId}`, {
                headers: bearer(account.accessToken),
              })
            ).status(),
          { message: 'the export is built', timeout: 120_000, intervals: [2_000, 5_000] }
        )
        .toBe(200);
      const ready = await context.get(`${apiUrl()}/api/users/me/data-export/${exportJobId}`, {
        headers: bearer(account.accessToken),
      });
      const download = (await ready.json()) as { url?: string; filename?: string };
      expect(download.url).toBeTruthy();
      expect(download.filename).toMatch(/\.zip$/);
    } finally {
      await context.dispose();
    }
  });

  test('A5.2 a deleted account is gone once its grace period ends', async ({ request, playwright }) => {
    const account = await apiCreateThrowawayUser(request, 'lra52d');
    const context = await signedInAs(playwright, account);
    try {
      const requested = await context.post(`${apiUrl()}/api/account/deletion`, {
        headers: bearer(account.accessToken),
      });
      expect(requested.status(), await requested.text()).toBe(202);
      const pending = await context.get(`${apiUrl()}/api/account/deletion`, { headers: bearer(account.accessToken) });
      expect(((await pending.json()) as { deletion: unknown }).deletion).toBeTruthy();
    } finally {
      await context.dispose();
    }

    const secret = process.env.E2E_CLEANUP_SECRET || Resource.E2E_CLEANUP_SECRET?.value;
    const expired = await request.post(`${apiUrl()}/api/test/expire-account-deletion`, {
      headers: { 'x-e2e-cleanup-secret': secret ?? '' },
      data: { email: account.email },
    });
    test.skip(
      expired.status() === 403,
      'The stage has no test trigger for the deletion sweep, and the real sweep runs on its daily schedule'
    );
    expect(expired.status(), await expired.text()).toBe(200);
    expect(((await expired.json()) as { deleted?: boolean }).deleted).toBe(true);

    const lookup = await request.get(`${apiUrl()}/api/users/${account.userId}`, { headers: bearer(adminToken()) });
    expect(lookup.status(), 'the admin lookup of the deleted account').toBe(404);
  });

  test('A5.2 deleting an account removes its processor customer and its mail subscription', async () => {
    test.skip(
      true,
      "Needs the Stripe test-mode secret key and the mail provider's API to look the records up after the purge; this suite holds neither"
    );
  });
});
