import { describe, it, expect } from 'vitest';
import { AdminTab } from './adminSidebarConfig';
import { canRenderAdminTab } from './adminTabRenderability';

const admin = { isAdmin: true };

describe('canRenderAdminTab', () => {
  it('keeps Migrate hidden until user migration is enabled', () => {
    expect(canRenderAdminTab(AdminTab.Migrate, { user: admin })).toBe(false);
    expect(canRenderAdminTab(AdminTab.Migrate, { user: admin, enableUserMigration: false })).toBe(false);
    expect(canRenderAdminTab(AdminTab.Migrate, { user: admin, enableUserMigration: true })).toBe(true);
  });

  it('rejects a retired tab id', () => {
    for (const retired of [
      4,
      11,
      17,
      35,
      AdminTab.RegistrationInvites,
      AdminTab.PartnerSignupRules,
      AdminTab.HeldSignupGrants,
    ]) {
      expect(canRenderAdminTab(retired as AdminTab, { user: admin })).toBe(false);
    }
  });

  it('rejects the retired issue filing page, which has no panel of its own', () => {
    expect(canRenderAdminTab(AdminTab.SecOpsTriage, { user: admin })).toBe(false);
  });

  it('rejects model lifecycle, which has no panel of its own', () => {
    expect(canRenderAdminTab(AdminTab.ModelLifecycle, { user: admin })).toBe(false);
  });

  it('accepts a tab that has a panel', () => {
    expect(canRenderAdminTab(AdminTab.Users, { user: admin })).toBe(true);
    expect(canRenderAdminTab(AdminTab.Models, { user: admin })).toBe(true);
  });

  it("hides a tab the user's admin permissions do not open", () => {
    const delegate = { isAdmin: false, adminPermissions: ['settings:manage'] };
    expect(canRenderAdminTab(AdminTab.Modals, { user: delegate })).toBe(true);
    expect(canRenderAdminTab(AdminTab.Users, { user: delegate })).toBe(false);
    expect(canRenderAdminTab(AdminTab.Users, { user: { isAdmin: false } })).toBe(false);
  });
});
