/* eslint-disable react-hooks/rules-of-hooks */
import { test as base } from '@playwright/test';
import { installWafBypass, scopeWafBypass } from './helpers/waf-bypass';

/** Playwright's `test` with the WAF bypass on every page, popup and `request` call to the API origin. */
export const test = base.extend({
  context: async ({ context }, use) => {
    await installWafBypass(context);
    await use(context);
  },
  request: async ({ request }, use) => {
    await use(scopeWafBypass(request));
  },
});
