import type { Locator, Page } from '@playwright/test';
import { TIMEOUTS } from '../constants';

/** Finds the visible checkout submit button without mistaking Stripe's Link wallet for payment. */
export async function payButton(page: Page, timeout: number = TIMEOUTS.ACTION): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const candidates = frame
          .getByTestId('hosted-payment-submit-button')
          .or(frame.getByRole('button', { name: /^(?:subscribe|pay)$/i }));
        for (const button of await candidates.all()) {
          if (await button.isVisible()) return button;
        }
      } catch (error) {
        if (!frame.isDetached()) throw error;
      }
    }
    await page.waitForTimeout(Math.min(TIMEOUTS.UI_SETTLE, Math.max(0, deadline - Date.now())));
  }
  const dump = await Promise.all(
    page.frames().map(async frame => {
      const tree = await frame
        .locator('body')
        .ariaSnapshot()
        .catch(() => '(unreadable)');
      return `${frame.url()}\n${tree.slice(0, 4000)}`;
    })
  );
  throw new Error(`No pay button in any of ${page.frames().length} frames:\n${dump.join('\n---\n')}`);
}
