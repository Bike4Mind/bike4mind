import { describe, it, expect } from 'vitest';
import { ADMIN_AUDIT_LOG_TAB_SLUG, ADMIN_FEEDBACK_TAB_SLUG, ADMIN_USERS_TAB_SLUG } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';
import { adminTabFromSlug } from './adminTabSlugs';

describe('adminTabFromSlug', () => {
  it('resolves the feedback slug to the feedback tab', () => {
    expect(adminTabFromSlug(ADMIN_FEEDBACK_TAB_SLUG)).toBe(AdminTab.Feedback);
  });

  it('resolves the audit log slug to the audit log tab', () => {
    expect(adminTabFromSlug(ADMIN_AUDIT_LOG_TAB_SLUG)).toBe(AdminTab.AuditLog);
  });

  it('resolves the users slug to the users tab', () => {
    expect(adminTabFromSlug(ADMIN_USERS_TAB_SLUG)).toBe(AdminTab.Users);
  });

  /**
   * The whole reason slugs exist. AdminTab's values are positional, so a link carrying the
   * number would silently retarget the first time someone inserts a tab above it - and these
   * links live in Slack messages and emails that outlive any one deploy.
   */
  it('does not accept the tab enum number as a slug', () => {
    expect(adminTabFromSlug(String(AdminTab.Feedback))).toBeUndefined();
  });

  /**
   * AdminPage's effect guards with `!== undefined` rather than a truthiness check, because
   * AdminTab.Users is 0. That guard is only correct if "not linkable" is exactly `undefined`,
   * so a falsy-but-valid tab stays distinguishable from an unknown slug.
   */
  it('reports an unknown or absent slug as exactly undefined', () => {
    expect(adminTabFromSlug('not-a-tab')).toBeUndefined();
    expect(adminTabFromSlug('')).toBeUndefined();
    expect(adminTabFromSlug(undefined)).toBeUndefined();
  });

  it('does not resolve slugs off the prototype chain', () => {
    expect(adminTabFromSlug('toString')).toBeUndefined();
    expect(adminTabFromSlug('constructor')).toBeUndefined();
  });
});
