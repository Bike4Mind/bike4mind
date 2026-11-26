import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab, SIDEBAR_SECTIONS, filterSidebarSections } from './adminSidebarConfig';
import { SidebarNav, type SidebarNavProps } from './AdminSidebarNav';
import {
  ADMIN_ACTION_COUNT_CAP,
  ADMIN_ACTION_COUNT_KEYS,
  ADMIN_ACTION_COUNT_LABELS,
  type AdminActionCountKey,
} from '@bike4mind/server-utils/app/components/admin/adminActionCounts';
import { onOpenAdminCommandPalette } from './shared/adminKeyboard';
import { withContributedPages, type ContributedAdminPage } from './adminContributedPages';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const renderNav = (props: Partial<SidebarNavProps> = {}) => {
  const onTabSelect = vi.fn();
  render(<SidebarNav activeTab={AdminTab.Dashboard} hiddenNotifications={[]} onTabSelect={onTabSelect} {...props} />, {
    wrapper: Wrapper,
  });
  return { onTabSelect };
};

const filterInput = () => screen.getByTestId('admin-sidebar-filter-input');

describe('SidebarNav', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('action count badges', () => {
    const countedItems = SIDEBAR_SECTIONS.flatMap(section => section.items).filter(
      (item): item is typeof item & { badge: AdminActionCountKey } =>
        item.badge !== undefined && item.badge !== 'newSubscriptions'
    );

    it('gives every counted queue a sidebar item, or a delegate badge on one', () => {
      const delegateKeys = SIDEBAR_SECTIONS.flatMap(section => section.items).flatMap(item =>
        item.delegateBadge ? [item.delegateBadge] : []
      );
      expect([...countedItems.map(item => item.badge), ...delegateKeys].sort()).toEqual(
        [...ADMIN_ACTION_COUNT_KEYS].sort()
      );
    });

    it('shows a delegated admin the held grants count in place of the waitlist count', () => {
      renderNav({ isFullAdmin: false, actionCounts: { heldSignupGrants: 4, waitingSubscribers: 9 } });
      expect(screen.getByTestId('admin-sidebar-heldSignupGrants-badge')).toHaveTextContent('4');
      expect(screen.queryByTestId('admin-sidebar-waitingSubscribers-badge')).toBeNull();
    });

    it('shows a full admin the waitlist count and not the held grants count', () => {
      renderNav({ actionCounts: { heldSignupGrants: 4, waitingSubscribers: 9 } });
      expect(screen.getByTestId('admin-sidebar-waitingSubscribers-badge')).toHaveTextContent('9');
      expect(screen.queryByTestId('admin-sidebar-heldSignupGrants-badge')).toBeNull();
    });

    it.each(countedItems.map(item => [item.badge, item.tab] as const))(
      'badges %s when its count is above zero and hides it at zero',
      (key, tab) => {
        const { unmount } = render(
          <SidebarNav activeTab={tab} hiddenNotifications={[]} onTabSelect={vi.fn()} actionCounts={{ [key]: 3 }} />,
          { wrapper: Wrapper }
        );
        const badge = screen.getByTestId(`admin-sidebar-${key}-badge`);
        expect(badge).toHaveTextContent('3');
        expect(badge).toHaveAttribute('aria-label', `3 ${ADMIN_ACTION_COUNT_LABELS[key]}`);
        unmount();

        renderNav({ activeTab: tab, actionCounts: { [key]: 0 } });
        expect(screen.queryByTestId(`admin-sidebar-${key}-badge`)).toBeNull();
      }
    );

    it('shows no badge for a count that failed or that the admin may not see', () => {
      renderNav({ actionCounts: { unreviewedAudit: null } });
      expect(screen.queryByTestId('admin-sidebar-unreviewedAudit-badge')).toBeNull();
      expect(screen.queryByTestId('admin-sidebar-moderationReview-badge')).toBeNull();
    });

    it('caps a count at 99+', () => {
      renderNav({ actionCounts: { moderationReview: ADMIN_ACTION_COUNT_CAP } });
      expect(screen.getByTestId('admin-sidebar-moderationReview-badge')).toHaveTextContent('99+');
    });

    it('keeps the waiting-subscribers count hidden when the admin dismissed that notification', () => {
      renderNav({ actionCounts: { waitingSubscribers: 5 }, hiddenNotifications: ['waiting-subscribers'] });
      expect(screen.queryByTestId('admin-sidebar-waitingSubscribers-badge')).toBeNull();
    });

    it('keeps an item with work waiting out from under More', () => {
      renderNav({ actionCounts: { signupRiskReview: 2 } });
      expect(screen.getByTestId('admin-signup-risk-review-btn')).toBeInTheDocument();
      expect(screen.getByTestId('admin-sidebar-signupRiskReview-badge')).toHaveTextContent('2');
      expect(screen.queryByRole('link', { name: /Signup domain holds/ })).toBeNull();
    });

    it('marks a rail section that holds work waiting, and only that one', () => {
      renderNav({ collapsed: true, onToggleCollapsed: vi.fn(), actionCounts: { deadLetters: 1 } });
      expect(screen.getByTestId('admin-sidebar-rail-platform-work-dot')).toBeInTheDocument();
      expect(screen.getByTestId('admin-sidebar-rail-platform-btn')).toHaveAttribute(
        'aria-label',
        'Platform, work waiting'
      );
      expect(screen.queryByTestId('admin-sidebar-rail-people-work-dot')).toBeNull();
    });
  });

  it('selects the Dashboard tab from the Dashboard link', () => {
    const { onTabSelect } = renderNav();

    fireEvent.click(screen.getByTestId('admin-dashboard-tab-btn'));

    expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.Dashboard);
  });

  it('renders items as real links to their tab URL and lets modified clicks through', () => {
    const { onTabSelect } = renderNav({ activeTab: AdminTab.Users });
    const users = screen.getByTestId('admin-users-tab-btn');

    expect(users).toHaveAttribute('href', '/admin?tab=users');
    fireEvent.click(users, { metaKey: true });

    expect(onTabSelect).not.toHaveBeenCalled();
  });

  it('renders a static label for every section', () => {
    renderNav();

    for (const section of SIDEBAR_SECTIONS) {
      expect(screen.getByTestId(`admin-sidebar-section-${section.key}`)).toHaveTextContent(section.label);
    }
    expect(screen.getByTestId('admin-sidebar-section-trust')).toHaveTextContent('Trust and safety');
  });

  it('marks only the active tab with aria-current', () => {
    renderNav({ activeTab: AdminTab.Users });

    expect(screen.getByTestId('admin-users-tab-btn')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('admin-dashboard-tab-btn')).not.toHaveAttribute('aria-current');
  });

  it('reaches preserved testids without opening anything', () => {
    renderNav();

    expect(screen.getByTestId('admin-dashboard-tab-btn')).toBeInTheDocument();
    expect(screen.getByTestId('admin-settings-btn')).toBeInTheDocument();
  });

  it.each([
    ['Staging', 'Staging'],
    [null, undefined],
  ])('names the environment beside the brand: %s', (environmentLabel, expected) => {
    renderNav({ environmentLabel });
    expect(screen.queryByTestId('admin-sidebar-environment-chip')?.textContent).toBe(expected);
  });

  it('selects the clicked tab', () => {
    const { onTabSelect } = renderNav();

    fireEvent.click(screen.getByTestId('admin-settings-btn'));

    expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.AdminSettings);
  });

  describe('More row', () => {
    it('shows the first five items of a long section and hides the rest behind More', () => {
      renderNav();

      expect(screen.getByTestId('admin-users-tab-btn')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Signup domain holds' })).toBeNull();
      const more = screen.getByTestId('admin-sidebar-more-people-btn');
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(more).toHaveTextContent('More');
    });

    it('expands and collapses in place', () => {
      renderNav();
      const more = screen.getByTestId('admin-sidebar-more-people-btn');

      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'true');
      expect(more).toHaveTextContent('Less');
      expect(screen.getByRole('link', { name: 'Signup domain holds' })).toBeInTheDocument();

      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('link', { name: 'Signup domain holds' })).toBeNull();
    });

    it('keeps an active item past the cut visible', () => {
      renderNav({ activeTab: AdminTab.SignupDomainHolds });

      expect(screen.getByRole('link', { name: 'Signup domain holds' })).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('link', { name: 'Feedback' })).toBeNull();
    });

    it('has no More row for a short section', () => {
      renderNav();

      expect(screen.queryByTestId('admin-sidebar-more-overview-btn')).toBeNull();
      expect(screen.queryByTestId('admin-sidebar-more-money-btn')).toBeNull();
    });
  });

  describe('permission gates', () => {
    it('keeps gated tabs out of the nav by default', () => {
      renderNav();
      fireEvent.click(screen.getByTestId('admin-sidebar-more-people-btn'));

      expect(screen.queryByRole('link', { name: 'Migration' })).toBeNull();
    });

    it('shows gated tabs when their gate is on', () => {
      renderNav({ enableUserMigration: true });
      fireEvent.click(screen.getByTestId('admin-sidebar-more-people-btn'));

      expect(screen.getByRole('link', { name: 'Migration' })).toBeInTheDocument();
    });
  });

  describe('new subscriptions dot', () => {
    it('marks Subscriptions with a labelled dot when a new one started', () => {
      renderNav({ newSubscriptions: true });

      const dot = screen.getByRole('img', { name: 'New subscriptions since your last visit' });
      expect(dot).toHaveAttribute('data-testid', 'admin-sidebar-new-subscriptions-dot');
      expect(screen.getByRole('link', { name: /Subscriptions/ })).toContainElement(dot);
    });

    it('shows no dot by default', () => {
      renderNav();

      expect(screen.queryByTestId('admin-sidebar-new-subscriptions-dot')).toBeNull();
    });
  });

  describe('footer', () => {
    it('shows the signed-in account name and role', () => {
      renderNav({ account: { name: 'Ada Admin', role: 'Super admin' } });

      const account = screen.getByTestId('admin-sidebar-account');
      expect(account).toHaveTextContent('Ada Admin');
      expect(account).toHaveTextContent('Super admin');
    });

    it('omits the account block without an account', () => {
      renderNav();

      expect(screen.queryByTestId('admin-sidebar-account')).toBeNull();
    });
  });

  describe('filter', () => {
    it('narrows every section to matching pages, even hidden ones', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'log' } });

      expect(screen.getByTestId('admin-audit-log-btn')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Webhook audit logs' })).toBeInTheDocument();
      expect(screen.queryByTestId('admin-users-tab-btn')).toBeNull();
      expect(screen.queryByTestId('admin-dashboard-tab-btn')).toBeNull();
    });

    it('matches on the section name too', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'platform' } });

      expect(screen.getByTestId('admin-sre-agent-btn')).toBeInTheDocument();
    });

    it('shows no More row while filtering', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'people' } });

      expect(screen.getByRole('link', { name: 'Signup domain holds' })).toBeInTheDocument();
      expect(screen.queryByTestId('admin-sidebar-more-people-btn')).toBeNull();
    });

    it('selects the first match on Enter and clears itself', () => {
      const { onTabSelect } = renderNav();

      fireEvent.change(filterInput(), { target: { value: 'rate li' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.RateLimits);
      expect(filterInput()).toHaveValue('');
    });

    it('lists Dependencies first for "dep"', () => {
      const { onTabSelect } = renderNav();

      fireEvent.change(filterInput(), { target: { value: 'dep' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.Dependencies);
    });

    it('does nothing on Enter when nothing matches', () => {
      const { onTabSelect } = renderNav();

      fireEvent.change(filterInput(), { target: { value: 'zzz' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onTabSelect).not.toHaveBeenCalled();
    });

    it('offers a way out when nothing matches', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'zzz' } });
      expect(screen.getByTestId('admin-sidebar-filter-empty')).toHaveTextContent('No pages match');

      fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
      expect(filterInput()).toHaveValue('');
      expect(screen.queryByTestId('admin-sidebar-filter-empty')).toBeNull();
      expect(screen.getByTestId('admin-dashboard-tab-btn')).toBeInTheDocument();
    });

    it('clears on Escape', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'zzz' } });
      fireEvent.keyDown(filterInput(), { key: 'Escape' });

      expect(filterInput()).toHaveValue('');
      expect(screen.getByTestId('admin-dashboard-tab-btn')).toBeInTheDocument();
    });
  });

  describe('keyboard', () => {
    it('moves focus with the arrow keys, Home and End, starting from the filter', () => {
      renderNav();
      const dashboard = screen.getByTestId('admin-dashboard-tab-btn');

      filterInput().focus();
      fireEvent.keyDown(filterInput(), { key: 'ArrowDown' });
      expect(dashboard).toHaveFocus();

      fireEvent.keyDown(dashboard, { key: 'ArrowDown' });
      expect(screen.getByRole('link', { name: 'Analytics' })).toHaveFocus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
      expect(screen.getByTestId('admin-sidebar-more-settings-btn')).toHaveFocus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
      expect(dashboard).toHaveFocus();

      fireEvent.keyDown(dashboard, { key: 'ArrowUp' });
      expect(filterInput()).toHaveFocus();
    });

    it('takes `/` only when no page search claimed it first', () => {
      // jsdom has no layout, so offsetParent is always null; the handler reads it as "filter visible".
      const offsetParent = vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(document.body);
      const pageSearch = document.createElement('input');
      document.body.append(pageSearch);
      const claim = (event: KeyboardEvent) => {
        event.preventDefault();
        pageSearch.focus();
      };
      try {
        renderNav();
        fireEvent.keyDown(document.body, { key: '/' });
        expect(filterInput()).toHaveFocus();

        (document.activeElement as HTMLElement).blur();
        window.addEventListener('keydown', claim, true);
        fireEvent.keyDown(document.body, { key: '/' });
        expect(pageSearch).toHaveFocus();
      } finally {
        window.removeEventListener('keydown', claim, true);
        pageSearch.remove();
        offsetParent.mockRestore();
      }
    });
  });

  describe('collapse', () => {
    it('shows the command palette hint and a collapse toggle when collapsible', () => {
      const onToggleCollapsed = vi.fn();
      renderNav({ onToggleCollapsed });

      expect(screen.getByTestId('admin-sidebar-command-hint')).toHaveTextContent(/K$/);
      fireEvent.click(screen.getByTestId('admin-sidebar-collapse-btn'));

      expect(onToggleCollapsed).toHaveBeenCalledOnce();
    });

    it.each([
      ['the brand row hint', false, 'admin-sidebar-command-hint'],
      ['the rail button', true, 'admin-sidebar-rail-command-btn'],
    ])('opens the command palette from %s', (_, collapsed, testId) => {
      const opened = vi.fn();
      const stop = onOpenAdminCommandPalette(opened);
      renderNav({ collapsed, onToggleCollapsed: vi.fn() });

      fireEvent.click(screen.getByTestId(testId));

      expect(opened).toHaveBeenCalledOnce();
      stop();
    });

    it('has no collapse toggle in the phone drawer', () => {
      const onClose = vi.fn();
      renderNav({ onClose });

      expect(screen.queryByTestId('admin-sidebar-collapse-btn')).toBeNull();
      fireEvent.click(screen.getByTestId('admin-sidebar-close-btn'));
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('folds to an icon rail with one labelled button per section', () => {
      const onToggleCollapsed = vi.fn();
      renderNav({ collapsed: true, onToggleCollapsed, activeTab: AdminTab.Users });

      expect(screen.getByTestId('admin-sidebar-nav')).toHaveAttribute('data-collapsed', 'true');
      expect(screen.queryByTestId('admin-sidebar-filter-input')).toBeNull();
      for (const section of SIDEBAR_SECTIONS) {
        expect(screen.getByTestId(`admin-sidebar-rail-${section.key}-btn`)).toHaveAttribute(
          'aria-label',
          section.label
        );
      }

      fireEvent.click(screen.getByTestId('admin-sidebar-expand-btn'));
      expect(onToggleCollapsed).toHaveBeenCalledOnce();
    });

    it('expands from the rail filter button', () => {
      const onToggleCollapsed = vi.fn();
      renderNav({ collapsed: true, onToggleCollapsed });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-filter-btn'));

      expect(onToggleCollapsed).toHaveBeenCalledOnce();
    });

    it('opens a section menu from the rail and selects from it', () => {
      const { onTabSelect } = renderNav({ collapsed: true, onToggleCollapsed: vi.fn() });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-trust-btn'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Audit log' }));

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.AuditLog);
    });

    it('ignores a filter query left over from before collapsing', () => {
      const onTabSelect = vi.fn();
      const props = {
        activeTab: AdminTab.Dashboard,
        hiddenNotifications: [],
        onTabSelect,
        onToggleCollapsed: vi.fn(),
      };
      const { rerender } = render(<SidebarNav {...props} />, { wrapper: Wrapper });
      fireEvent.change(filterInput(), { target: { value: 'rate li' } });

      rerender(<SidebarNav {...props} collapsed />);

      for (const section of SIDEBAR_SECTIONS) {
        expect(screen.getByTestId(`admin-sidebar-rail-${section.key}-btn`)).toBeInTheDocument();
      }
    });

    it('lists every item of a long section in the rail menu', () => {
      renderNav({ collapsed: true, onToggleCollapsed: vi.fn() });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-people-btn'));

      expect(screen.getByRole('menuitem', { name: 'Signup domain holds' })).toBeInTheDocument();
    });
  });
});

describe('filterSidebarSections', () => {
  const allOpen = { userMigration: true };

  it('returns every section unfiltered for a blank query', () => {
    expect(filterSidebarSections(SIDEBAR_SECTIONS, allOpen, '  ')).toHaveLength(SIDEBAR_SECTIONS.length);
  });

  it('drops gated items whose gate is off', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, { userMigration: false }, '');
    const tabs = sections.flatMap(section => section.items.map(item => item.tab));
    expect(tabs).not.toContain(AdminTab.Migrate);
  });

  it('is case-insensitive and omits empty sections', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, 'SLACK');
    expect(sections.map(section => section.key)).toEqual(['platform']);
  });

  it('drops tabs the user may not open, and the sections they leave empty', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, '', tab => tab === AdminTab.Modals);
    expect(sections.map(section => section.key)).toEqual(['settings']);
    expect(sections[0].items.map(item => item.tab)).toEqual([AdminTab.Modals]);
  });

  it('matches an item by a former name', () => {
    const items = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, 'waitlist').flatMap(section => section.items);
    expect(items.map(item => item.label)).toEqual(['Invite Center']);
  });

  it('still finds Webhook audit logs by its former name', () => {
    const items = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, 'webhook logs').flatMap(section => section.items);
    expect(items.map(item => item.label)).toEqual(['Webhook audit logs']);
  });

  it('finds Models by the names of the pages folded into it', () => {
    for (const query of [
      'llm dashboard',
      'model lifecycle',
      'lifecycle',
      'model pricing',
      'model prices',
      'discovery',
    ]) {
      const tabs = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, query).flatMap(section =>
        section.items.map(item => item.tab)
      );
      expect(tabs, query).toContain(AdminTab.Models);
    }
  });

  it('keeps the Models aliases from outranking the pages that own a common query', () => {
    const first = (query: string) =>
      filterSidebarSections(SIDEBAR_SECTIONS, allOpen, query).flatMap(section => section.items)[0]?.tab;
    expect(first('pricing')).toBe(AdminTab.GrowthPricing);
    const settings = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, 'settings').flatMap(section => section.items);
    expect(settings.map(item => item.tab)).toContain(AdminTab.AdminSettings);
    expect(settings.map(item => item.tab)).not.toContain(AdminTab.Models);
  });
});

describe('SidebarNav contributed pages', () => {
  const pages: ContributedAdminPage[] = [
    { path: '/admin/ext/reports', adminPage: { section: 'money', label: 'Reports', testId: 'ext-reports-link' } },
    { path: '/admin/ext/audits', adminPage: { section: 'platform', label: 'Audits' } },
  ];
  const sections = withContributedPages(SIDEBAR_SECTIONS, pages);
  const reportsLink = () => screen.getByTestId('ext-reports-link');
  const currentLinks = () => screen.getAllByRole('link').filter(link => link.getAttribute('aria-current') === 'page');
  // useId numbers differ between two renders in one file, and nothing else about the markup may.
  const markup = (container: HTMLElement) => container.innerHTML.replace(/_r_[0-9a-z]+_/g, '_r_id_');

  beforeEach(() => {
    window.localStorage.clear();
  });

  it('lists a page after the items of the section it names, as a link to its path', () => {
    renderNav({ sections });

    const money = within(screen.getByTestId('admin-sidebar-section-money'));
    const links = money.getAllByRole('link');
    expect(links.at(-1)).toBe(reportsLink());
    expect(reportsLink()).toHaveTextContent('Reports');
    expect(reportsLink()).toHaveAttribute('href', '/admin/ext/reports');
    expect(links.slice(0, -1).map(link => link.textContent)).toEqual(
      SIDEBAR_SECTIONS.find(section => section.key === 'money')!.items.map(item => item.label)
    );
    expect(within(screen.getByTestId('admin-sidebar-section-people')).queryByTestId('ext-reports-link')).toBeNull();
  });

  it('derives a testid from the path when the page gives none', () => {
    renderNav({ sections, activePagePath: '/admin/ext/audits' });

    expect(screen.getByTestId('admin-ext-audits-btn')).toHaveTextContent('Audits');
  });

  it('hides the page from a user who may not open it, and keeps every tab', () => {
    renderNav({ sections, canOpenPage: () => false });

    expect(screen.queryByTestId('ext-reports-link')).toBeNull();
    expect(screen.queryByText('Reports')).toBeNull();
    expect(screen.getByTestId('admin-revenue-btn')).toBeInTheDocument();
  });

  it('marks the open page current and no tab item', () => {
    renderNav({ sections, activeTab: null, activePagePath: '/admin/ext/reports' });

    expect(reportsLink()).toHaveAttribute('aria-current', 'page');
    expect(currentLinks()).toEqual([reportsLink()]);
  });

  it('matches the open path across a trailing slash and letter case', () => {
    renderNav({ sections, activeTab: null, activePagePath: '/Admin/Ext/Reports/' });

    expect(reportsLink()).toHaveAttribute('aria-current', 'page');
  });

  it('marks no page current while a tab is open', () => {
    renderNav({ sections, activeTab: AdminTab.Revenue });

    expect(reportsLink()).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('admin-revenue-btn')).toHaveAttribute('aria-current', 'page');
  });

  it('opens the page in-app on a plain click and leaves a modified click to the browser', () => {
    const onPageSelect = vi.fn();
    const { onTabSelect } = renderNav({ sections, onPageSelect });

    fireEvent.click(reportsLink(), { metaKey: true });
    expect(onPageSelect).not.toHaveBeenCalled();

    fireEvent.click(reportsLink());
    expect(onPageSelect).toHaveBeenCalledExactlyOnceWith('/admin/ext/reports');
    expect(onTabSelect).not.toHaveBeenCalled();
  });

  it('leaves the click to the browser when nothing handles it', () => {
    renderNav({ sections });
    const click = createEvent.click(reportsLink());

    fireEvent(reportsLink(), click);

    expect(click.defaultPrevented).toBe(false);
  });

  describe('More row', () => {
    const platformSections = withContributedPages(SIDEBAR_SECTIONS, [pages[1]]);

    it('puts a page past the cut behind More, like a trailing item', () => {
      renderNav({ sections: platformSections });

      expect(screen.queryByTestId('admin-ext-audits-btn')).toBeNull();
      fireEvent.click(screen.getByTestId('admin-sidebar-more-platform-btn'));
      expect(screen.getByTestId('admin-ext-audits-btn')).toBeInTheDocument();
    });

    it('keeps the open page visible past the cut', () => {
      renderNav({ sections: platformSections, activeTab: null, activePagePath: '/admin/ext/audits' });

      expect(screen.getByTestId('admin-ext-audits-btn')).toHaveAttribute('aria-current', 'page');
      expect(screen.getByTestId('admin-sidebar-more-platform-btn')).toBeInTheDocument();
    });
  });

  describe('filter', () => {
    it('finds a page by its label, even one behind More', () => {
      renderNav({ sections: withContributedPages(SIDEBAR_SECTIONS, [pages[1]]) });

      fireEvent.change(filterInput(), { target: { value: 'audits' } });

      const platform = within(screen.getByTestId('admin-sidebar-section-platform'));
      expect(platform.getByTestId('admin-ext-audits-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('admin-sidebar-section-money')).toBeNull();
    });

    it('opens the first match on Enter when it is a page', () => {
      const onPageSelect = vi.fn();
      const { onTabSelect } = renderNav({ sections, onPageSelect });

      fireEvent.change(filterInput(), { target: { value: 'reports' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onPageSelect).toHaveBeenCalledExactlyOnceWith('/admin/ext/reports');
      expect(onTabSelect).not.toHaveBeenCalled();
      expect(filterInput()).toHaveValue('');
    });

    it('shows a page under a section label match', () => {
      renderNav({ sections });

      fireEvent.change(filterInput(), { target: { value: 'money' } });

      expect(reportsLink()).toBeInTheDocument();
    });
  });

  describe('collapsed rail', () => {
    it('lists the page in its section menu and opens it from there', () => {
      const onPageSelect = vi.fn();
      renderNav({ sections, collapsed: true, onToggleCollapsed: vi.fn(), onPageSelect });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-money-btn'));
      const item = screen.getByRole('menuitem', { name: 'Reports' });
      expect(item).toHaveAttribute('data-testid', 'ext-reports-link');
      fireEvent.click(item);

      expect(onPageSelect).toHaveBeenCalledExactlyOnceWith('/admin/ext/reports');
    });

    it('marks the open page current in the menu', () => {
      renderNav({
        sections,
        collapsed: true,
        onToggleCollapsed: vi.fn(),
        activeTab: null,
        activePagePath: '/admin/ext/reports',
      });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-money-btn'));

      expect(screen.getByRole('menuitem', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByRole('menuitem', { name: 'Credits' })).not.toHaveAttribute('aria-current');
    });

    it('leaves the menu without the page for a user who may not open it', () => {
      renderNav({ sections, collapsed: true, onToggleCollapsed: vi.fn(), canOpenPage: () => false });

      fireEvent.click(screen.getByTestId('admin-sidebar-rail-money-btn'));

      expect(screen.queryByRole('menuitem', { name: 'Reports' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Credits' })).toBeInTheDocument();
    });
  });

  describe('with no contributed pages', () => {
    it.each([
      ['expanded', false],
      ['collapsed', true],
    ])('renders the %s sidebar markup for markup as the static sections do', (_, collapsed) => {
      const base = {
        activeTab: AdminTab.Users,
        hiddenNotifications: [],
        onTabSelect: vi.fn(),
        collapsed,
        onToggleCollapsed: vi.fn(),
      };
      const first = render(<SidebarNav {...base} />, { wrapper: Wrapper });
      const before = markup(first.container);
      first.unmount();

      const second = render(
        <SidebarNav
          {...base}
          sections={withContributedPages(SIDEBAR_SECTIONS, [])}
          canOpenPage={() => true}
          activePagePath={null}
          onPageSelect={vi.fn()}
        />,
        { wrapper: Wrapper }
      );

      expect(markup(second.container)).toBe(before);
    });
  });
});
