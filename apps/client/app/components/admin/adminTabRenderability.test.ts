import { describe, it, expect } from 'vitest';
import { AdminTab } from './adminSidebarConfig';
import { canRenderAdminTab } from './adminTabRenderability';

describe('canRenderAdminTab', () => {
  it('keeps Migrate hidden until user migration is enabled', () => {
    expect(canRenderAdminTab(AdminTab.Migrate)).toBe(false);
    expect(canRenderAdminTab(AdminTab.Migrate, { enableUserMigration: false })).toBe(false);
    expect(canRenderAdminTab(AdminTab.Migrate, { enableUserMigration: true })).toBe(true);
  });

  it('keeps a LiveOps deep link until the visibility query answers', () => {
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage)).toBe(true);
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage, { liveOpsTriage: true })).toBe(true);
    expect(canRenderAdminTab(AdminTab.LiveOpsTriage, { liveOpsTriage: false })).toBe(false);
  });

  it('rejects legacy tabs that have no panel', () => {
    for (const tab of [AdminTab.Accounts, AdminTab.Analysts, AdminTab.BulkImport]) {
      expect(canRenderAdminTab(tab)).toBe(false);
    }
  });

  it('accepts a tab that has a panel', () => {
    expect(canRenderAdminTab(AdminTab.Users)).toBe(true);
    expect(canRenderAdminTab(AdminTab.LLMDashboard)).toBe(true);
  });
});
