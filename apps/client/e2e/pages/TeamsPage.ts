import { expect, type Locator } from '@playwright/test';
import { TIMEOUTS } from '../constants';
import { BasePage } from './BasePage';

/** Tab labels as the team detail page renders them (app/routes/organizations/$id.tsx). */
export type TeamTab =
  | 'Overview'
  | 'Members'
  | 'Groups'
  | 'Usage'
  | 'Analysis'
  | 'Billing'
  | 'Integrations'
  | 'GitHub API'
  | 'Webhooks'
  | 'Connectors'
  | 'Settings';

export const ALL_TEAM_TABS: TeamTab[] = [
  'Overview',
  'Members',
  'Groups',
  'Usage',
  'Analysis',
  'Billing',
  'Integrations',
  'GitHub API',
  'Webhooks',
  'Connectors',
  'Settings',
];

/**
 * Page object for Teams: the list (`/organizations`), the Create Team modal, and a team's detail page
 * (`/organizations/$id`). The routes still say "organizations"; the product says "Teams".
 *
 * Selector notes:
 *  - Tabs carry no testid of their own; they are reached by role inside `organization-tabs`.
 *  - Member rows are keyed by `data-user-id`, so a row is found by id, not by a name that could
 *    collide with another seeded user.
 */
export class TeamsPage extends BasePage {
  async gotoList() {
    await this.page.goto('/organizations');
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('organizations-create-team-btn')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  teamCard(organizationId: string): Locator {
    return this.page.locator(`[data-testid="organization-card"][data-org-id="${organizationId}"]`);
  }

  teamCardByName(name: string): Locator {
    return this.page.getByTestId('organization-card').filter({ hasText: name });
  }

  async search(query: string) {
    await this.page.getByTestId('organizations-search-input').fill(query);
  }

  async gotoTeam(organizationId: string, tab?: string) {
    await this.page.goto(`/organizations/${organizationId}${tab ? `?tab=${tab}` : ''}`);
    await this.page.waitForLoadState('domcontentloaded');
    await this.dismissModals();
    await expect(this.page.getByTestId('organization-tabs')).toBeVisible({ timeout: TIMEOUTS.NAVIGATION });
  }

  tab(name: TeamTab): Locator {
    return this.page.getByTestId('organization-tabs').getByRole('tab', { name, exact: true });
  }

  async openTab(name: TeamTab) {
    await this.tab(name).click();
    await expect(this.tab(name)).toHaveAttribute('aria-selected', 'true');
  }

  /** The tab labels the current viewer is shown, in order. */
  async visibleTabs(): Promise<string[]> {
    const tabs = this.page.getByTestId('organization-tabs').getByRole('tab');
    return (await tabs.allInnerTexts()).map(t => t.trim());
  }

  // --- Members tab -----------------------------------------------------------

  memberRow(userId: string): Locator {
    return this.page.locator(`[data-testid="organization-user-card"][data-user-id="${userId}"]`);
  }

  memberRows(): Locator {
    return this.page.getByTestId('organization-user-card');
  }

  /** "X of N seats used" from the Seat Management card, as numbers. */
  async seatsUsed(): Promise<{ used: number; max: number }> {
    const text = await this.page.getByTestId('organization-members-seats-count').innerText();
    const match = text.match(/(\d+) of (\d+) seats used/);
    if (!match) throw new Error(`Unexpected seat count text: "${text}"`);
    return { used: Number(match[1]), max: Number(match[2]) };
  }

  async openMemberMenu(userId: string) {
    await this.memberRow(userId).getByTestId('org-user-card-menu-btn').click();
  }

  async confirm() {
    const confirmBtn = this.page.getByTestId('confirmation-modal-confirm-btn');
    await expect(confirmBtn).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await confirmBtn.click();
    await expect(this.page.getByTestId('confirmation-modal')).toBeHidden({ timeout: TIMEOUTS.MODAL });
  }

  /** Add Member -> search -> pick the user by name -> Add. The pick sends an invite, not a membership. */
  async inviteMember(searchTerm: string, name: string) {
    await this.page.getByTestId('organization-members-add-btn').click();
    const modal = this.page.getByTestId('generic-add-items-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await modal.getByTestId('generic-add-items-search-input').filter({ visible: true }).first().fill(searchTerm);
    const item = modal.getByTestId('generic-add-items-item').filter({ hasText: name });
    await expect(item).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
    await item.click();
    await modal.getByTestId('generic-add-items-submit-btn').click();
    await expect(modal).toBeHidden({ timeout: TIMEOUTS.MODAL });
  }

  // --- Create Team modal -------------------------------------------------------

  async openCreateTeam(): Promise<Locator> {
    await this.page.getByTestId('organizations-create-team-btn').click();
    const modal = this.page.getByTestId('create-team-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUTS.MODAL });
    return modal;
  }

  createTeamNameInput(): Locator {
    return this.page.getByTestId('create-team-name-input');
  }

  createTeamSizeInput(): Locator {
    return this.page.getByTestId('create-team-size-value');
  }

  createTeamSubmit(): Locator {
    return this.page.getByTestId('create-team-submit-btn');
  }

  createTeamPrice(): Locator {
    return this.page.getByTestId('create-team-price-value');
  }
}
