import { describe, expect, it } from 'vitest';
import type { IUserDocument } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';
import { canAccessAdminTab } from './adminTabRenderability';

const supportUser = { isAdmin: false, adminPermissions: ['support:read'] } as IUserDocument;

describe('admin tab access', () => {
  it('allows delegated support to reach user lookup without settings or key actions', () => {
    expect(canAccessAdminTab(supportUser, AdminTab.Users)).toBe(true);
    expect(canAccessAdminTab(supportUser, AdminTab.AdminSettings)).toBe(false);
    expect(canAccessAdminTab(supportUser, AdminTab.EmbedKeys)).toBe(false);
  });

  it('admits settings delegates to embed key configuration', () => {
    expect(
      canAccessAdminTab({ isAdmin: false, adminPermissions: ['settings:manage'] } as IUserDocument, AdminTab.EmbedKeys)
    ).toBe(true);
  });

  it('routes credits and moderation delegates to the matching administration panels', () => {
    const credits = { isAdmin: false, adminPermissions: ['credits:adjust'] } as IUserDocument;
    const moderator = { isAdmin: false, adminPermissions: ['users:moderate'] } as IUserDocument;
    expect(canAccessAdminTab(credits, AdminTab.CreditAnalytics)).toBe(true);
    expect(canAccessAdminTab(credits, AdminTab.Organizations)).toBe(true);
    expect(canAccessAdminTab(moderator, AdminTab.PublishedPages)).toBe(true);
    expect(canAccessAdminTab(credits, AdminTab.PublishedPages)).toBe(false);
    expect(canAccessAdminTab(moderator, AdminTab.CreditAnalytics)).toBe(false);
  });

  it('retains full admin access and denies users without grants', () => {
    const admin = { isAdmin: true } as IUserDocument;
    for (const tab of [AdminTab.Users, AdminTab.AdminSettings, AdminTab.EmbedKeys]) {
      expect(canAccessAdminTab(admin, tab)).toBe(true);
      expect(canAccessAdminTab(null, tab)).toBe(false);
    }
  });
});
