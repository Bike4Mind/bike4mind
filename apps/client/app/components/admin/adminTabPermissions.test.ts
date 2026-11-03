import { describe, expect, it } from 'vitest';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';
import { canEnterAdminConsole, canOpenAdminTab, DELEGATED_ADMIN_TAB_PERMISSIONS } from './adminTabPermissions';

const admin = { isAdmin: true };
const delegate = (...adminPermissions: string[]) => ({ isAdmin: false, adminPermissions });

describe('canOpenAdminTab', () => {
  it('opens every tab for a full admin', () => {
    expect(canOpenAdminTab(admin, AdminTab.Users)).toBe(true);
    expect(canOpenAdminTab(admin, AdminTab.Modals)).toBe(true);
  });

  it('opens a mapped tab for a delegate holding its permission', () => {
    expect(canOpenAdminTab(delegate('settings:manage'), AdminTab.Modals)).toBe(true);
  });

  it('keeps unmapped tabs full-admin only, whatever the delegate holds', () => {
    const everything = delegate('support:read', 'settings:manage', 'users:moderate', 'credits:adjust');
    expect(canOpenAdminTab(everything, AdminTab.Users)).toBe(false);
    expect(canOpenAdminTab(everything, AdminTab.WhatsNewModals)).toBe(false);
  });

  it('refuses a mapped tab to a delegate without its permission', () => {
    expect(canOpenAdminTab(delegate('support:read'), AdminTab.Modals)).toBe(false);
  });

  it('refuses everything to a user with no admin role', () => {
    expect(canOpenAdminTab({ isAdmin: false }, AdminTab.Modals)).toBe(false);
    expect(canOpenAdminTab(null, AdminTab.Modals)).toBe(false);
  });
});

// Admission counts mapped tabs; the console then falls back to the first sidebar tab it can draw.
// A mapped tab that is gated or off the sidebar would admit a delegate to a console with no tab.
it('maps only ungated sidebar tabs', () => {
  const ungatedSidebarTabs = SIDEBAR_SECTIONS.flatMap(section => section.items)
    .filter(item => !item.gate)
    .map(item => item.tab);
  for (const tab of Object.keys(DELEGATED_ADMIN_TAB_PERMISSIONS).map(Number)) {
    expect(ungatedSidebarTabs).toContain(tab);
  }
});

describe('canEnterAdminConsole', () => {
  it('admits a full admin and a delegate with a tab to open', () => {
    expect(canEnterAdminConsole(admin)).toBe(true);
    expect(canEnterAdminConsole(delegate('settings:manage'))).toBe(true);
  });

  it('turns away a delegate whose permissions open no tab', () => {
    expect(canEnterAdminConsole(delegate('support:read'))).toBe(false);
  });

  it('turns away a user with no admin permissions', () => {
    expect(canEnterAdminConsole({ isAdmin: false, adminPermissions: [] })).toBe(false);
    expect(canEnterAdminConsole(undefined)).toBe(false);
  });
});
