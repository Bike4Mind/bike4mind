import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab, SIDEBAR_SECTIONS, filterSidebarSections } from './adminSidebarConfig';
import { SidebarNav, type SidebarNavProps } from './AdminSidebarNav';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

const renderNav = (props: Partial<SidebarNavProps> = {}) => {
  const onTabSelect = vi.fn();
  render(
    <SidebarNav
      activeTab={AdminTab.Dashboard}
      showLiveOpsTriageTab={false}
      hiddenNotifications={[]}
      onTabSelect={onTabSelect}
      {...props}
    />,
    { wrapper: Wrapper }
  );
  return { onTabSelect };
};

const filterInput = () => screen.getByTestId('admin-sidebar-filter-input');

describe('SidebarNav', () => {
  beforeEach(() => {
    window.localStorage.clear();
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
      expect(screen.queryByRole('link', { name: 'Partner signups' })).toBeNull();
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
      expect(screen.getByRole('link', { name: 'Partner signups' })).toBeInTheDocument();

      fireEvent.click(more);
      expect(more).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('link', { name: 'Partner signups' })).toBeNull();
    });

    it('keeps an active item past the cut visible', () => {
      renderNav({ activeTab: AdminTab.PartnerSignupRules });

      expect(screen.getByRole('link', { name: 'Partner signups' })).toHaveAttribute('aria-current', 'page');
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
      expect(screen.queryByRole('link', { name: 'LiveOps triage' })).toBeNull();
    });

    it('shows gated tabs when their gate is on', () => {
      renderNav({ enableUserMigration: true, showLiveOpsTriageTab: true });
      fireEvent.click(screen.getByTestId('admin-sidebar-more-people-btn'));

      expect(screen.getByRole('link', { name: 'Migration' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'LiveOps triage' })).toBeInTheDocument();
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
      expect(screen.getByRole('link', { name: 'Webhook logs' })).toBeInTheDocument();
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

      expect(screen.getByRole('link', { name: 'Partner signups' })).toBeInTheDocument();
      expect(screen.queryByTestId('admin-sidebar-more-people-btn')).toBeNull();
    });

    it('selects the first match on Enter and clears itself', () => {
      const { onTabSelect } = renderNav();

      fireEvent.change(filterInput(), { target: { value: 'rate li' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.RateLimits);
      expect(filterInput()).toHaveValue('');
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
        showLiveOpsTriageTab: false,
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

      expect(screen.getByRole('menuitem', { name: 'Partner signups' })).toBeInTheDocument();
    });
  });
});

describe('filterSidebarSections', () => {
  const allOpen = { userMigration: true, liveOpsTriage: true };

  it('returns every section unfiltered for a blank query', () => {
    expect(filterSidebarSections(SIDEBAR_SECTIONS, allOpen, '  ')).toHaveLength(SIDEBAR_SECTIONS.length);
  });

  it('drops gated items whose gate is off', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, { userMigration: false, liveOpsTriage: false }, '');
    const tabs = sections.flatMap(section => section.items.map(item => item.tab));
    expect(tabs).not.toContain(AdminTab.Migrate);
    expect(tabs).not.toContain(AdminTab.LiveOpsTriage);
  });

  it('is case-insensitive and omits empty sections', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, allOpen, 'SLACK');
    expect(sections.map(section => section.key)).toEqual(['platform']);
  });
});
