import { describe, expect, it } from 'vitest';
import { AdminTab } from './adminSidebarConfig';
import { canEnterAdminConsole, canOpenAdminTab } from './adminTabPermissions';

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
