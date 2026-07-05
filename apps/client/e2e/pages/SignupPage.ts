import { expect } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class SignupPage extends BasePage {
  async goto() {
    await this.page.goto('/register');
  }

  async gotoFromLogin() {
    await this.page.goto('/login');
    await this.page.getByTestId('signup-text').click();
    await this.page.waitForURL(/.*register.*/, { timeout: TIMEOUTS.VISIBLE });
  }

  async fillUsername(username: string) {
    await this.page.getByTestId('register-username-input').getByRole('textbox').fill(username);
  }

  async fillEmail(email: string) {
    await this.page.getByTestId('register-email-input').getByRole('textbox').fill(email);
  }

  /** Blur the email field to surface its inline validation error (shown on blur, not on submit). */
  async blurEmail() {
    await this.page.getByTestId('register-email-input').getByRole('textbox').blur();
  }

  /**
   * Tick the two required consent checkboxes (Terms/AUP/Privacy + 18+ age attestation).
   * Both are `z.literal(true)` in the register schema, so the submit button stays disabled
   * until both are checked. Must be called before submit() on the OTC request step.
   */
  async acceptPolicies() {
    await this.page.getByTestId('register-aup-tos-checkbox').getByRole('checkbox').check();
    await this.page.getByTestId('register-age-checkbox').getByRole('checkbox').check();
  }

  /** Submit the first step (username + email) to request a one-time code. */
  async submit() {
    await this.page.getByTestId('register-submit-btn').click();
  }

  /** Fill the one-time code on the second (verification) step. */
  async fillOtc(code: string) {
    await this.page.getByTestId('register-otc-input').locator('input').fill(code);
  }

  /** Verify the entered one-time code. */
  async verify() {
    await this.page.getByTestId('register-verify-btn').click();
  }

  /** Wait for the code-entry step to appear after requesting a code. */
  async expectOtcStep() {
    await expect(this.page.getByTestId('register-otc-input')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  async expectOnRegisterPage() {
    await expect(this.page).toHaveURL(/.*register.*/);
  }

  async expectValidationError(message: string) {
    // Field-level errors render as inline <Typography className="register-*-error">,
    // while server/banner errors use role="alert". Match either by visible text.
    const error = this.page.locator('[role="alert"], [class*="-error"]').filter({ hasText: message });
    await expect(error.first()).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  }
}
