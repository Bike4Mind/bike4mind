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

  it('keeps a LiveOps deep link until the visibility query answers', () => {
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage, { user: admin })).toBe(true);
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage, { user: admin, liveOpsTriage: true })).toBe(true);
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage, { user: admin, liveOpsTriage: false })).toBe(false);
  });

  it('rejects legacy tabs that have no panel', () => {
    for (const tab of [AdminTab.Accounts, AdminTab.Analysts, AdminTab.BulkImport]) {
      expect(canRenderAdminTab(tab, { user: admin })).toBe(false);
    }
  });

  it('accepts a tab that has a panel', () => {
    expect(canRenderAdminTab(AdminTab.Users, { user: admin })).toBe(true);
    expect(canRenderAdminTab(AdminTab.LLMDashboard, { user: admin })).toBe(true);
  });

  it("hides a tab the user's admin permissions do not open", () => {
    const delegate = { isAdmin: false, adminPermissions: ['settings:manage'] };
    expect(canRenderAdminTab(AdminTab.Modals, { user: delegate })).toBe(true);
    expect(canRenderAdminTab(AdminTab.Users, { user: delegate })).toBe(false);
    expect(canRenderAdminTab(AdminTab.Users, { user: { isAdmin: false } })).toBe(false);
  });
});
