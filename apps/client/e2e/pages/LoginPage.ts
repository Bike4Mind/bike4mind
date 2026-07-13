import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  async goto() {
    await this.page.goto('/login');
  }

  async fillEmail(email: string) {
    await this.submitEmail(email);
    // Wait for the strategy check + OTC send round-trip, then the code-entry step.
    await this.expectOtcStep();
  }

  /**
   * Fill the email and click Continue WITHOUT waiting for the OTC step, so a caller can inspect the
   * strategy/send responses first (e.g. to skip on a shared-IP 429) before asserting the code step.
   */
  async submitEmail(email: string) {
    await this.fillMuiInput(this.page.getByTestId('login-email-input').getByRole('textbox'), email);
    const continueBtn = this.page.getByTestId('login-continue-btn');
    await expect(continueBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await continueBtn.click();
  }

  /** Wait for the OTC code-entry step to appear after a successful send (ACTION headroom for cold starts). */
  async expectOtcStep() {
    await this.page.getByTestId('login-otc-input').waitFor({ state: 'visible', timeout: TIMEOUTS.ACTION });
  }

  async fillOtc(code: string) {
    await this.fillMuiInput(this.page.getByTestId('login-otc-input').locator('input'), code);
  }

  async submit() {
    const verifyBtn = this.page.getByTestId('login-verify-btn');
    await expect(verifyBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await verifyBtn.click();
    await this.page.waitForURL(/(?!.*login).*/, { timeout: TIMEOUTS.ACTION });
  }

  async submitAndExpectFailure() {
    const verifyBtn = this.page.getByTestId('login-verify-btn');
    await expect(verifyBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await verifyBtn.click();
    // Intentionally does NOT wait for URL change - login stays on /login
  }

  /**
   * Verify the entered code WITHOUT expecting login to complete. When the email has no account
   * yet, the server answers `registrationRequired` and the login form advances to its inline
   * `register-username` step (see MultiStepLogin) rather than redirecting off /login.
   */
  async submitExpectingInlineRegister() {
    const verifyBtn = this.page.getByTestId('login-verify-btn');
    await expect(verifyBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await verifyBtn.click();
  }

  /** Wait for the inline registration (username) step to appear after a verified code for a new email. */
  async expectInlineRegisterStep() {
    await expect(this.page.getByTestId('login-register-username-input')).toBeVisible({
      timeout: TIMEOUTS.NAVIGATION,
    });
  }

  async fillInlineRegisterUsername(username: string) {
    await this.fillMuiInput(this.page.getByTestId('login-register-username-input').getByRole('textbox'), username);
  }

  /**
   * Tick the two required consent checkboxes on the inline register step (Terms/AUP/Privacy + 18+).
   * Both gate the Create account button, and the server rejects account creation without them.
   */
  async acceptInlineRegisterPolicies() {
    await this.checkMuiCheckbox(this.page.getByTestId('login-register-aup-tos-checkbox').getByRole('checkbox'));
    await this.checkMuiCheckbox(this.page.getByTestId('login-register-age-checkbox').getByRole('checkbox'));
  }

  /** Submit the inline register step to create the account, then wait to be routed off /login. */
  async submitInlineRegister() {
    const createBtn = this.page.getByTestId('login-register-username-btn');
    await expect(createBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await createBtn.click();
    await this.page.waitForURL(url => !url.toString().includes('/login'), { timeout: TIMEOUTS.ACTION });
  }

  async waitForLoginSuccess() {
    await this.page.waitForURL(url => !url.toString().includes('/login'), {
      timeout: TIMEOUTS.TEST,
    });
    // "Signing in as..." is a post-redirect loading indicator that may not render on fast/cached
    // logins. Only wait for it to disappear if it actually appears after the URL change; otherwise
    // waitFor({ state: 'hidden' }) resolves immediately for non-existent elements and races past
    // a login that hasn't fully initialized yet.
    const signingIn = this.page.getByText(/Signing in as/i);
    const appeared = await signingIn
      .waitFor({ state: 'visible', timeout: TIMEOUTS.ELEMENT_STATE })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await signingIn.waitFor({ state: 'hidden', timeout: TIMEOUTS.TEST });
    }
  }

  async expectLoginPage() {
    await expect(this.page).toHaveURL(/.*login.*/);
  }

  async expectErrorToast(message: string) {
    // Sonner toasts render in [data-sonner-toaster] container
    const toast = this.page.locator('[data-sonner-toast]').filter({ hasText: message });
    await expect(toast).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }

  /**
   * Submit the OTC code for an MFA-enrolled user. Unlike submit(), this does NOT wait for a
   * redirect - a correct code opens the MFA challenge modal instead of completing login.
   */
  async submitOtcExpectingMfa() {
    const verifyBtn = this.page.getByTestId('login-verify-btn');
    await expect(verifyBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await verifyBtn.click();
  }

  /** Wait for the MFA challenge modal (MFAModal) to appear after submitOtcExpectingMfa(). */
  async expectMfaChallenge() {
    await expect(this.page.getByTestId('mfa-modal-code-input')).toBeVisible({ timeout: TIMEOUTS.ACTION });
  }

  /** Fill the MFA challenge's single code input - accepts both a 6-digit TOTP and a 10-char backup code. */
  async fillMfaCode(code: string) {
    await this.fillMuiInput(this.page.getByTestId('mfa-modal-code-input').locator('input'), code);
  }

  /** Submit the MFA challenge and wait for login to complete (redirect off /login). */
  async submitMfa() {
    const verifyBtn = this.page.getByTestId('mfa-modal-verify-btn');
    await expect(verifyBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await verifyBtn.click();
    await this.page.waitForURL(url => !url.toString().includes('/login'), { timeout: TIMEOUTS.ACTION });
  }
}
