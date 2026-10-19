import { describe, it, expect } from 'vitest';
import { ADMIN_FEEDBACK_TAB_SLUG } from '@bike4mind/common';
import { AdminTab } from './adminSidebarConfig';
import { adminTabFromSlug, adminTabToSlug } from './adminTabSlugs';

const ALL_TABS = Object.values(AdminTab).filter((value): value is AdminTab => typeof value === 'number');

describe('adminTabToSlug', () => {
  it('gives every AdminTab member a URL-safe slug', () => {
    for (const tab of ALL_TABS) {
      expect(adminTabToSlug(tab), `AdminTab ${AdminTab[tab]}`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('never reuses a slug', () => {
    const slugs = ALL_TABS.map(tab => adminTabToSlug(tab));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('round-trips every tab through its slug', () => {
    for (const tab of ALL_TABS) {
      expect(adminTabFromSlug(adminTabToSlug(tab))).toBe(tab);
    }
  });

  it('keeps the slugs links already carry', () => {
    expect(adminTabToSlug(AdminTab.Feedback)).toBe(ADMIN_FEEDBACK_TAB_SLUG);
    expect(adminTabToSlug(AdminTab.Users)).toBe('users');
  });

  it('writes nothing for a value that is not an AdminTab member', () => {
    expect(adminTabToSlug(null)).toBeUndefined();
    expect(adminTabToSlug('some-injected-tab')).toBeUndefined();
    expect(adminTabToSlug(9999 as AdminTab)).toBeUndefined();
  });
});

describe('adminTabFromSlug', () => {
  it('resolves the feedback slug to the feedback tab', () => {
    expect(adminTabFromSlug(ADMIN_FEEDBACK_TAB_SLUG)).toBe(AdminTab.Feedback);
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
    expect(adminTabFromSlug('__proto__')).toBeUndefined();
  });
});
