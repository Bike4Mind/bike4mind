/* eslint-disable react-hooks/rules-of-hooks */
import { test as base } from '@playwright/test';
import { redactAuthError } from './helpers/error-text';
import { installWafBypass, scopeWafBypass } from './helpers/waf-bypass';

/** Playwright's `test` with the WAF bypass on every page, popup and `request` call to the API origin,
 *  and with the /auth/success token left out of reported error text. */
export const test = base.extend<{ errorText: void }>({
  // Keep final test errors scrubbed even when a caller overrides the configured reporters.
  // The first configured reporter also scrubs the separate, earlier step-error stream.
  errorText: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here
    async ({}, use, testInfo) => {
      await use();
      for (const error of testInfo.errors) redactAuthError(error);
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
