import { describe, it, expect } from 'vitest';
import { ADMIN_AUDIT_LOG_TAB_SLUG, FEEDBACK_ID_PARAM } from '@bike4mind/common';
import { ADMIN_GLOBAL_PARAMS, ADMIN_TAB_PARAMS, adminSearchForTab } from './adminTabParams';
import { adminTabFromSlug } from './adminTabSlugs';

describe('ADMIN_TAB_PARAMS', () => {
  it('is keyed by real tab slugs', () => {
    for (const slug of Object.keys(ADMIN_TAB_PARAMS)) {
      expect(adminTabFromSlug(slug), slug).toBeDefined();
    }
  });

  // A name shared by two tabs (or with a console-wide param) would survive a switch between them.
  it('gives every param exactly one owner', () => {
    const all = [...ADMIN_GLOBAL_PARAMS, ...Object.values(ADMIN_TAB_PARAMS).flat()];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('adminSearchForTab', () => {
  it('ignores a slug that resolves to an inherited object member', () => {
    expect(adminSearchForTab({ section: 'x', feedbackId: 'f' }, 'constructor')).toEqual({ tab: 'constructor' });
  });

  it('keeps the slug own params and drops another tab params', () => {
    const search = adminSearchForTab(
      {
        tab: ADMIN_AUDIT_LOG_TAB_SLUG,
        [FEEDBACK_ID_PARAM]: 'feedback-1',
        category: 'access',
        section: 'aiConfiguration',
        q: 'slack',
      },
      'admin-settings'
    );

    expect(search).toMatchObject({ tab: 'admin-settings', section: 'aiConfiguration', q: 'slack' });
    expect(search[FEEDBACK_ID_PARAM]).toBeUndefined();
    expect(search.category).toBeUndefined();
  });
});
