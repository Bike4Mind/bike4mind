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

  it('marks the active tab and opens its section on first load', () => {
    renderNav({ activeTab: AdminTab.Users });

    expect(screen.getByTestId('admin-users-tab-btn')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'People' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Security' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('toggles a section open and closed', () => {
    renderNav();
    const security = screen.getByRole('button', { name: 'Security' });

    fireEvent.click(security);
    expect(security).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('admin-audit-log-btn')).toBeInTheDocument();

    fireEvent.click(security);
    expect(security).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('admin-audit-log-btn')).toBeNull();
  });

  it('keeps permission-gated tabs out of the nav', () => {
    renderNav({ activeTab: AdminTab.Users });
    expect(screen.queryByRole('link', { name: 'Migration' })).toBeNull();
  });

  describe('filter', () => {
    it('narrows every section to matching pages, even collapsed ones', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'log' } });

      expect(screen.getByTestId('admin-audit-log-btn')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Webhook Logs' })).toBeInTheDocument();
      expect(screen.queryByTestId('admin-users-tab-btn')).toBeNull();
      expect(screen.queryByTestId('admin-dashboard-tab-btn')).toBeNull();
    });

    it('matches on the section name too', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'reliability' } });

      expect(screen.getByTestId('admin-sre-agent-btn')).toBeInTheDocument();
    });

    it('selects the first match on Enter and clears itself', () => {
      const { onTabSelect } = renderNav();

      fireEvent.change(filterInput(), { target: { value: 'rate li' } });
      fireEvent.keyDown(filterInput(), { key: 'Enter' });

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.RateLimits);
      expect(filterInput()).toHaveValue('');
    });

    it('offers a way out when nothing matches, and Escape clears it', () => {
      renderNav();

      fireEvent.change(filterInput(), { target: { value: 'zzz' } });
      expect(screen.getByTestId('admin-sidebar-filter-empty')).toHaveTextContent('No pages match');

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
      expect(screen.getByRole('button', { name: 'People' })).toHaveFocus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
      expect(screen.getByRole('button', { name: 'Docs' })).toHaveFocus();

      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
      expect(dashboard).toHaveFocus();

      fireEvent.keyDown(dashboard, { key: 'ArrowUp' });
      expect(filterInput()).toHaveFocus();
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
      renderNav({ onClose: vi.fn() });

      expect(screen.queryByTestId('admin-sidebar-collapse-btn')).toBeNull();
      expect(screen.getByTestId('admin-sidebar-close-btn')).toBeInTheDocument();
    });

    it('folds to an icon rail with one labelled button per section', () => {
      const onToggleCollapsed = vi.fn();
      renderNav({ collapsed: true, onToggleCollapsed, activeTab: AdminTab.Users });

      expect(screen.getByTestId('admin-sidebar-nav')).toHaveAttribute('data-collapsed', 'true');
      expect(screen.queryByTestId('admin-sidebar-filter-input')).toBeNull();
      for (const section of SIDEBAR_SECTIONS) {
        expect(screen.getByRole('button', { name: section.label })).toBeInTheDocument();
      }

      fireEvent.click(screen.getByTestId('admin-sidebar-expand-btn'));
      expect(onToggleCollapsed).toHaveBeenCalledOnce();
    });

    it('opens a section menu from the rail and selects from it', () => {
      const { onTabSelect } = renderNav({ collapsed: true, onToggleCollapsed: vi.fn() });

      fireEvent.click(screen.getByRole('button', { name: 'Security' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Audit Log' }));

      expect(onTabSelect).toHaveBeenCalledExactlyOnceWith(AdminTab.AuditLog);
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
    expect(sections.map(section => section.key)).toEqual(['integrations']);
  });
});
