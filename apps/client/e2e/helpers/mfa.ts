import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { createHash } from 'crypto';
import { TOTP_STEP_SECONDS, totpCode } from '@bike4mind/auth/mfaService/totp';
import { TIMEOUTS } from '../constants';
import { BasePage } from '../pages/BasePage';
import type { LoginPage } from '../pages/LoginPage';
import { apiGetMfaCode, apiGetOtcCode, refreshTokenFromSetCookie } from './api';

export interface MfaSetupResult {
  secret: string;
  qrCodeUrl: string;
  manualEntryKey: string;
  backupCodes: string[];
}

export interface MfaTokens {
  accessToken: string;
  refreshToken: string;
}

function currentTotpStep(): number {
  return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Generate a TOTP code for a base32 secret, matching what an authenticator app would show.
 * The server rejects a code whose step is not newer than the last one it accepted (replay
 * guard), so pass `afterStep` (e.g. enrollMfa's `enrolledStep`) to get a code it will still take.
 * A code one step ahead is fine: the server verifies with a window of 1 step either side.
 */
export function generateTotp(secretBase32: string, afterStep?: number): string {
  const step = afterStep === undefined ? currentTotpStep() : Math.max(currentTotpStep(), afterStep + 1);
  return totpCode(secretBase32, step);
}

/** POST /api/auth/mfa/setup - generates a TOTP secret + backup codes (not yet enabled). */
export async function apiSetupMfa(request: APIRequestContext, accessToken: string): Promise<MfaSetupResult> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/auth/mfa/setup`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok()) {
    throw new Error(`MFA setup failed: ${response.status()} ${response.statusText()}`);
  }
  const result: MfaSetupResult = await response.json();
  return result;
}

/**
 * POST /api/auth/mfa/verify-setup - enables MFA and issues a fresh session. The token used to
 * call apiSetupMfa is invalidated by this call (tokenVersion bump), so callers must switch to the
 * returned tokens for any request made after enrollment. Only the access token is in the body;
 * the refresh token comes back as the HttpOnly cookie, so it has to be read off Set-Cookie.
 */
export async function apiVerifyMfaSetup(
  request: APIRequestContext,
  accessToken: string,
  code: string
): Promise<MfaTokens> {
  const baseURL = process.env.API_URL || 'http://localhost:3000';
  const response = await request.post(`${baseURL}/api/auth/mfa/verify-setup`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    data: { token: code },
  });
  if (!response.ok()) {
    throw new Error(`MFA verify-setup failed: ${response.status()} ${response.statusText()}`);
  }
  const refreshToken = refreshTokenFromSetCookie(response.headers()['set-cookie']);
  const { accessToken: freshAccessToken } = (await response.json()) as { accessToken?: string };
  if (!freshAccessToken || !refreshToken) {
    throw new Error(
      `MFA verify-setup returned no session (accessToken=${freshAccessToken ? 'set' : 'missing'}, ` +
        `refreshCookie=${refreshToken ? 'set' : 'missing'})`
    );
  }
  return { accessToken: freshAccessToken, refreshToken };
}

/**
 * Enroll MFA end-to-end via the API (setup + verify-setup), returning the secret, backup codes,
 * the post-enroll token pair (the pre-enroll accessToken passed in is no longer valid), and the
 * TOTP step the enrollment code consumed.
 */
export async function enrollMfa(
  request: APIRequestContext,
  accessToken: string
): Promise<{ secret: string; backupCodes: string[]; tokens: MfaTokens; enrolledStep: number }> {
  const setup = await apiSetupMfa(request, accessToken);
  const enrolledStep = currentTotpStep();
  const code = totpCode(setup.secret, enrolledStep);
  const tokens = await apiVerifyMfaSetup(request, accessToken, code);
  return { secret: setup.secret, backupCodes: setup.backupCodes, tokens, enrolledStep };
}

/**
 * Name of the per-account "remember this device" cookie. Mirrors trustedDeviceCookieName in
 * server/auth/trustedDevice.ts - keep in sync.
 */
export function trustedDeviceCookieName(userId: string): string {
  return `b4m_td_${createHash('sha256').update(userId).digest('hex').slice(0, 16)}`;
}

/**
 * Sign in through the login form with an emailed code and then a TOTP code. `totp` defaults to a
 * code from /api/test/mfa-code; pass one to test what an authenticator app would show.
 */
export async function signInWithTotp(
  loginPage: LoginPage,
  request: APIRequestContext,
  email: string,
  totp?: string,
  { rememberDevice = false }: { rememberDevice?: boolean } = {}
): Promise<void> {
  await loginPage.goto();
  await loginPage.submitEmail(email);
  await loginPage.expectOtcStep();
  await loginPage.fillOtc(await apiGetOtcCode(request, email));
  await loginPage.submitOtcExpectingMfa();
  await loginPage.expectMfaChallenge();
  await loginPage.fillMfaCode(totp ?? (await apiGetMfaCode(request, email)));
  if (rememberDevice) {
    await loginPage.checkMuiCheckbox(
      loginPage.page.getByTestId('mfa-modal-remember-device-checkbox').getByRole('checkbox')
    );
  }
  await loginPage.submitMfa();
}

const MFA_SETUP_PATH = '/api/auth/mfa/setup';

/**
 * For a sign-up driven through the UI. When the stage enforces MFA, /api/otc/verify answers a new
 * account with `mfaSetupRequired` and the app opens the setup dialog instead of signing in. Call
 * this before submitting the code (the setup call can land before the verify response is read),
 * then pass the verify body to `enrollIfAsked`, which completes setup from the dialog and returns
 * the new session's access token. It returns null when the stage asked for no setup.
 */
export function watchMfaSetup(page: Page) {
  let secret: string | undefined;
  const onResponse = async (res: Response) => {
    if (res.request().method() !== 'POST' || new URL(res.url()).pathname !== MFA_SETUP_PATH || !res.ok()) return;
    secret = ((await res.json()) as { secret: string }).secret;
  };
  page.on('response', onResponse);
  const dispose = () => {
    page.off('response', onResponse);
  };

  return {
    dispose,
    async enrollIfAsked(verifyBody: { mfaSetupRequired?: boolean }): Promise<{ accessToken: string } | null> {
      try {
        if (!verifyBody.mfaSetupRequired) return null;
        await expect(page.getByTestId('mfa-modal-content')).toBeVisible({ timeout: TIMEOUTS.MODAL });
        await expect.poll(() => secret, { timeout: TIMEOUTS.ACTION }).toBeTruthy();
        const verified = page.waitForResponse(
          res => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/auth/mfa/verify-setup',
          { timeout: TIMEOUTS.ACTION }
        );
        await new BasePage(page).fillMuiInput(
          page.getByTestId('mfa-modal-code-input').locator('input'),
          generateTotp(secret as string)
        );
        await page.getByTestId('mfa-modal-verify-btn').click();
        const response = await verified;
        expect(response.ok(), 'MFA verify-setup').toBe(true);
        const { accessToken } = (await response.json()) as { accessToken: string };
        await expect(page.getByTestId('mfa-modal-content')).toBeHidden({ timeout: TIMEOUTS.ACTION });
        return { accessToken };
      } finally {
        dispose();
      }
    },
  };
}
