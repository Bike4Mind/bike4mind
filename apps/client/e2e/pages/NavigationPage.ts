import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

export class NavigationPage extends BasePage {
  async navigateToNewChat() {
    await this.page.getByTestId('sidenav-nav-new-chat').click();
  }

  async openProjects() {
    // Projects is an earned-nav destination (Gears): the sidenav row is hidden until
    // the account has a project. Navigate directly, like a first-time user (Gears CTA).
    await this.page.goto('/projects');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async openProfile() {
    await this.page.getByTestId('profile-menu-card').click();
    await this.page.getByTestId('profile-menu-profile').click();
  }

  async openAgents() {
    // Agents is an earned-nav destination (Gears): the sidenav row is hidden until
    // the account has an agent. Navigate directly, like a first-time user (Gears CTA).
    await this.page.goto('/agents');
    await this.page.waitForLoadState('domcontentloaded');
  }

  async openMenu() {
    // UI_SETTLE: card is always mounted; if it isn't clickable within ~500ms the retry loop in logout() will re-open the menu.
    await this.page.getByTestId('profile-menu-card').click({ timeout: TIMEOUTS.UI_SETTLE });
  }

  /**
   * Signs out through the profile menu and waits for the app's post-sign-out reload. Sign-out routes
   * to /login in-app first, then hard-reloads to /login once client caches are cleared
   * (tearDownClientSession in app/hooks/data/user.ts). A navigation started in between is aborted by
   * that reload, so callers get control back only after it has loaded.
   */
  async logout() {
    // Dismiss any modal (e.g. What's New) that may overlay the sidenav
    await this.dismissModals();

    // The 'load' event fires for the hard reload only, never for the in-app route change.
    const reloaded = this.page.waitForEvent('load', {
      predicate: page => new URL(page.url()).pathname === '/login',
      timeout: TIMEOUTS.ACTION,
    });
    // Handled here so an early return or throw below never leaves the rejection unhandled.
    reloaded.catch(() => {});

    if (await this.clickLogout()) {
      await reloaded;
    }
  }

  /** Returns false when sign-out had already completed before the button could be clicked. */
  private async clickLogout(): Promise<boolean> {
    // Menu items can be detached by React re-renders (WebSocket/polling).
    // Retry: re-open the menu if the click fails due to detachment or visibility.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.openMenu();
      } catch (error) {
        if (this.page.isClosed()) {
          return false; // page is gone - logout navigation already completed
        }
        if (this.page.url().includes('login')) return false;
        throw error;
      }
      try {
        await this.page.getByTestId('logout-btn').click({ timeout: TIMEOUTS.ELEMENT_STATE });
        return true;
      } catch {
        if (attempt === maxAttempts) throw new Error('Failed to click logout button after retries');
        // Close the menu if it's stuck open but the item wasn't clickable
        await this.page.keyboard.press('Escape').catch(() => {});
      }
    }
    return false;
  }

  async navigateToAdmin() {
    await this.openMenu();
    await this.page.getByTestId('profile-menu-admin').click();
  }
}
