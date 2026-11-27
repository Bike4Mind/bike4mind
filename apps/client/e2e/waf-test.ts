/* eslint-disable react-hooks/rules-of-hooks */
import { test as base } from '@playwright/test';
import { omitAuthToken } from './helpers/auth-seed';
import { installWafBypass, scopeWafBypass } from './helpers/waf-bypass';

/** Playwright's `test` with the WAF bypass on every page, popup and `request` call to the API origin,
 *  and with the /auth/success token left out of reported error text. */
export const test = base.extend<{ errorText: void }>({
  // Navigation and URL assertion failures quote the page URL. Reporters read testInfo.errors when
  // the test ends, after this teardown.
  errorText: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
    async ({}, use, testInfo) => {
      await use();
      for (const error of testInfo.errors) {
        if (error.message) error.message = omitAuthToken(error.message);
        if (error.stack) error.stack = omitAuthToken(error.stack);
        if (error.value) error.value = omitAuthToken(error.value);
      }
    },
    { auto: true },
  ],
  context: async ({ context }, use) => {
    await installWafBypass(context);
    await use(context);
  },
  request: async ({ request }, use) => {
    await use(scopeWafBypass(request));
  },
});
