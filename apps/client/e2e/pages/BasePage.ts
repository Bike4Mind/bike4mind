import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { TIMEOUTS } from '../constants';

// Once a page's session has cleared the AUP/ToS consent gate we cache it here and skip the
// per-call localStorage probe on later dismissModals() calls. Safe because consent is monotonic
// (a user goes unconsented -> consented and never back); keyed by Page so it's shared across every
// page object wrapping the same page and garbage-collected when the page is disposed. (A future
// spec that intentionally seeds an UNCONSENTED user should do so on a fresh page/context, not by
// switching users on a page already marked cleared.)
const consentClearedByPage = new WeakMap<Page, boolean>();

export class BasePage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async clearAllStorage() {
    // Navigate to the app origin first so localStorage/sessionStorage are accessible
    // (about:blank throws SecurityError when accessing storage)
    if (this.page.url() === 'about:blank') {
      await this.page.goto('/');
    }
    await this.page.context().clearCookies();
    await this.page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();

      // Clear IndexedDB databases
      if (indexedDB.databases) {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
      }
    });
  }

  async handleWhatsNewModal() {
    // The whats-new announcement renders as one of two variants once the app has fetched
    // announcements: the multi-slide "slider" modal, or a single-card GenericModal (e.g. an
    // "Announcement" broadcast). ModalManager shows at most one, never both. Dismiss whichever
    // appears - either blocks the whole app behind a backdrop that intercepts pointer events, so
    // a live announcement on the target env would otherwise fail every click/hover after it mounts.
    const closeBtn = this.page
      .getByTestId('whats-new-slider-modal-close-btn-icon-container')
      .or(this.page.getByTestId('generic-modal-close-button-icon-container'))
      .first();
    // The modal renders asynchronously after fetching announcements -
    // give it a brief window to appear before deciding it won't show.
    const appeared = await closeBtn
      .waitFor({ state: 'visible', timeout: TIMEOUTS.VISIBLE })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await closeBtn.click();
    }
  }

  async handleEmailVerificationModal() {
    // The verification modal's dismiss action is now the "Got It" button (modal-close-btn),
    // scoped within the email-verification-modal so it doesn't match other modals' close buttons.
    const dismissBtn = this.page.getByTestId('email-verification-modal').getByTestId('modal-close-btn');
    if (await dismissBtn.isVisible().catch(() => false)) {
      await dismissBtn.click();
    }
  }

  async suppressEmailVerificationModal() {
    // Pre-set localStorage to prevent the email verification modal from appearing.
    // This is more reliable than waiting for the modal to render and clicking dismiss,
    // since the modal has a 3s delay and auth state may not preserve localStorage.
    await this.page.evaluate(() => {
      const key = 'b4m_email_verification_dismissed_at';

      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, Date.now().toString());
      }
    });
  }

  async handleAcceptPoliciesInterstitial() {
    // The AUP/ToS consent gate redirects any authenticated-but-not-yet-consented
    // account to the full-page /accept-policies interstitial. Freshly minted e2e users are
    // pre-stamped by /api/test/create-user, so this is a no-op for them; it's defense for a
    // user who reaches the gate anyway. When it fires, click through: check both boxes and
    // submit, then wait to be routed back into the app.
    //
    // The consent redirect is a CLIENT-SIDE router beforeLoad hop that lands a beat AFTER the
    // 'load' event (observed against staging: still /new at load, /accept-policies ~0.6-1.3s later,
    // with real run-to-run variance). So we can't check the URL once - that races past the redirect.
    //
    // But the redirect is driven purely by a falsy `currentUser.aupAcceptedVersion` in the seeded
    // `user-context` store (router beforeLoad; see auth-seed.ts). A stamped user NEVER redirects,
    // so read that flag first and skip the poll entirely - this keeps the handler ~zero-cost on the
    // common (consented) path, which matters because dismissModals runs ~35+ times per suite. The
    // poll below runs ONLY for a seeded-unconsented user (or when the flag can't be read), so the
    // window is sized for reliability against that observed variance, not for common-path speed.
    // Once cleared for this page we cache it (see consentClearedByPage) and skip even the probe.
    if (consentClearedByPage.get(this.page)) return;

    const CONSENT_REDIRECT_WINDOW = 3_000;
    if (!this.page.url().includes('/accept-policies')) {
      const mayNeedConsent = await this.page
        .evaluate(() => {
          try {
            const raw = localStorage.getItem('user-context');
            if (!raw) return true; // no seeded user → can't rule out the gate; poll to be safe
            return !JSON.parse(raw)?.state?.currentUser?.aupAcceptedVersion;
          } catch {
            return true;
          }
        })
        .catch(() => true);
      if (!mayNeedConsent) {
        consentClearedByPage.set(this.page, true); // stamped user → gate can't fire; skip future probes
        return;
      }
      await this.page
        .waitForURL(url => url.toString().includes('/accept-policies'), { timeout: CONSENT_REDIRECT_WINDOW })
        .catch(() => {}); // no redirect within the window → nothing to do
    }
    if (!this.page.url().includes('/accept-policies')) return;

    const submitBtn = this.page.getByTestId('accept-policies-submit-btn');
    await submitBtn.waitFor({ state: 'visible', timeout: TIMEOUTS.VISIBLE });
    await this.page.getByTestId('accept-policies-checkbox').click();
    await this.page.getByTestId('accept-age-checkbox').click();
    await expect(submitBtn).toBeEnabled({ timeout: TIMEOUTS.ELEMENT_STATE });
    await submitBtn.click();
    // Acceptance is recorded server-side, then the page redirects off /accept-policies.
    await this.page.waitForURL(url => !url.toString().includes('/accept-policies'), {
      timeout: TIMEOUTS.NAVIGATION,
    });
    consentClearedByPage.set(this.page, true); // now consented → skip future probes for this page
  }

  async dismissNextjsOverlay() {
    // Remove the Next.js dev overlay portal if present - it intercepts pointer events
    try {
      await this.page.evaluate(() => {
        document.querySelectorAll('nextjs-portal').forEach(el => el.remove());
      });
    } catch (e) {
      // Ignore if page is already closed
    }
  }

  async dismissModals() {
    // Wait for the SPA to fully hydrate before checking for modals.
    // domcontentloaded fires when HTML is parsed, but React hasn't mounted yet.
    // 'load' waits for all sub-resources (scripts, styles) so the SPA is interactive.
    // Bound this wait: under parallel load a preview's 'load' event can lag well past a minute,
    // which would hang here forever. Cap at NAVIGATION and continue - the per-page readiness
    // assertions (e.g. an explorer/panel toBeVisible) are the real gate, and every modal handler
    // below already probes defensively, so proceeding before 'load' is safe.
    await this.page.waitForLoadState('load', { timeout: TIMEOUTS.NAVIGATION }).catch(() => {});
    // Clear the AUP/ToS consent gate first - while it's up, the app chrome (and every other
    // modal) isn't mounted, so this must run before we probe for the What's New / verification modals.
    await this.handleAcceptPoliciesInterstitial();
    await this.suppressEmailVerificationModal();
    await this.handleWhatsNewModal();
    await this.handleEmailVerificationModal();
    await this.dismissNextjsOverlay();
  }

  async waitForPageLoad() {
    await this.page.waitForLoadState('domcontentloaded');
  }

  async waitForToast(text: string) {
    await expect(this.page.locator('[data-sonner-toast]').filter({ hasText: text })).toBeVisible({
      timeout: TIMEOUTS.VISIBLE,
    });
  }

  /**
   * Locate a profile form input by its label text.
   * The profile form uses a Grid layout where each field container has
   * a Typography label followed by an Input. We find the container
   * whose label matches exactly, then get its textbox.
   */
  getProfileFieldByLabel(label: string): Locator {
    return this.page
      .getByTestId('profile-form-field')
      .filter({ has: this.page.getByTestId('profile-form-label').getByText(label, { exact: true }) })
      .locator('[data-testid^="profile-form-input-"]')
      .getByRole('textbox');
  }

  /**
   * Fill a MUI Joy Input by setting the native value and dispatching React-compatible events.
   * MUI Joy's controlled Input doesn't always respond to Playwright's fill() because
   * React's internal _valueTracker may not detect the change.
   *
   * WARNING: Uses React internal `_valueTracker` - tested against React 19.x (^19.2.4).
   * May break on major React upgrades if the internal reconciliation mechanism changes.
   */
  async fillMuiInput(input: Locator, value: string) {
    await input.click();
    await input.evaluate((el: HTMLInputElement, val: string) => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      nativeInputValueSetter.call(el, val);
      // Set tracker to a sentinel that never matches the new value, so React
      // always detects a change - including when clearing to empty string.
      const tracker = (el as unknown as Record<string, unknown>)._valueTracker as
        { setValue: (v: string) => void } | undefined;
      if (tracker) tracker.setValue('__pw_dirty__');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
  }

  /**
   * Race a network response against a UI assertion - whichever resolves first wins.
   * After the race, the UI assertion is always re-verified to confirm the expected outcome.
   * This handles both fresh API calls and cache-served (no network) scenarios.
   */
  async waitForResponseOrUI(responseMatcher: (resp: Response) => boolean, uiAssertion: () => Promise<void>) {
    await Promise.race([this.page.waitForResponse(responseMatcher).catch(() => {}), uiAssertion()]);
    await uiAssertion();
  }

  /**
   * Tick a MUI Joy `Checkbox` whose label contains policy links.
   *
   * MUI Joy overlays a transparent full-width `<input>` (the "action" area) at `zIndex: 1` over the
   * whole control, but consent labels promote their policy `<Link>`s ABOVE that overlay
   * (`CHECKBOX_LABEL_LINK_SX`, see app/utils/externalLinks.ts). Playwright's `.check()` clicks the
   * input's center, which on a multi-line consent label lands on a link - Playwright reads that as
   * an intercepted click and retries until it times out. Click the top-left instead (the checkbox
   * square, never covered by a link), and only when not already checked so the toggle is idempotent.
   */
  async checkMuiCheckbox(checkbox: Locator) {
    if (await checkbox.isChecked()) return;
    await checkbox.click({ position: { x: 6, y: 6 } });
    await expect(checkbox).toBeChecked({ timeout: TIMEOUTS.ELEMENT_STATE });
  }

  async waitForLoaderToDisappear(selector: string) {
    // Wait directly for the hidden state. Playwright treats a not-yet-attached
    // element as already 'hidden', so this resolves immediately when the loader
    // never renders (e.g. a cached fetch that resolves before paint) and waits
    // through the full cycle when it does appear. Probing for 'visible' first
    // would time out and surface as a (caught but still reported) failed step
    // whenever the loader is too fast to observe.
    await this.page.getByTestId(selector).waitFor({ state: 'hidden', timeout: TIMEOUTS.LOADER_HIDDEN });
  }
}
