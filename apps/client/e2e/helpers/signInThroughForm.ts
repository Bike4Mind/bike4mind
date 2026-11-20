import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { apiGetMfaCode, apiGetOtcCode } from './api';
import { watchMfaSetup } from './mfa';
import type { LoginPage } from '../pages/LoginPage';

type VerifyBody = {
  email?: string;
  registrationRequired?: boolean;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
};

/**
 * Signs in through the login form and returns the verify response the app received. Handles the
 * account's second factor: a TOTP challenge once it is enrolled, or setup from the dialog when the
 * stage enforces MFA and the account has not enrolled yet.
 */
export async function signInThroughForm(page: Page, loginPage: LoginPage, request: APIRequestContext, email: string) {
  await loginPage.goto();
  await loginPage.fillEmail(email);
  const code = await apiGetOtcCode(request, email);
  await loginPage.fillOtc(code);
  const verified = page.waitForResponse(
    response => response.url().includes('/api/otc/verify') && response.request().method() === 'POST'
  );
  const mfaSetup = watchMfaSetup(page);
  try {
    const [response] = await Promise.all([verified, loginPage.submitOtcExpectingMfa()]);
    expect(response.status(), 'OTC verify').toBe(200);
    const body = (await response.json()) as VerifyBody;

    if (body.mfaRequired) {
      await loginPage.expectMfaChallenge();
      await loginPage.fillMfaCode(await apiGetMfaCode(request, email));
      await loginPage.submitMfa();
    } else {
      await mfaSetup.enrollIfAsked(body);
    }
    await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: TIMEOUTS.ACTION });
    return body;
  } finally {
    mfaSetup.dispose();
  }
}
