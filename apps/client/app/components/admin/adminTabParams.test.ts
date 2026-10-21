import { describe, it, expect } from 'vitest';
import { ADMIN_AUDIT_LOG_TAB_SLUG, FEEDBACK_ID_PARAM } from '@bike4mind/common';
import { ADMIN_GLOBAL_PARAMS, ADMIN_TAB_PARAMS, adminSearchForTab, parseAdminSearch } from './adminTabParams';
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

describe('Users tab params', () => {
  const usersSearch = {
    tab: 'users',
    page: 2,
    limit: 20,
    sort: 'name',
    order: 'asc',
    org: ['Acme'],
    tags: ['Admin'],
    userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  };

  it('coerces each param in validateSearch and drops invalid ones', () => {
    expect(
      parseAdminSearch({
        page: '2',
        limit: 7,
        sort: 'password',
        order: 'asc',
        org: 'Acme',
        tags: [],
        userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      })
    ).toMatchObject({
      page: 2,
      limit: undefined,
      sort: undefined,
      order: 'asc',
      org: ['Acme'],
      tags: undefined,
      userId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('never accepts the free-text search', () => {
    expect(parseAdminSearch({ search: 'someone@example.com' })).not.toHaveProperty('search');
  });

  it('keeps them on the users tab and drops them on a switch away', () => {
    expect(adminSearchForTab(usersSearch, 'users')).toMatchObject(usersSearch);

    const switched = adminSearchForTab(usersSearch, 'admin-settings');
    for (const key of ['page', 'limit', 'sort', 'order', 'org', 'tags', 'userId'] as const) {
      expect(switched[key], key).toBeUndefined();
    }
  });
});

describe('Feedback tab params', () => {
  const feedbackSearch = {
    tab: 'feedback',
    feedbackStatus: 'New,Closed',
    feedbackSubject: 'turn',
    feedbackOrg: ['Acme'],
    feedbackOrder: 'asc',
    feedbackPage: 2,
    feedbackLimit: 50,
    [FEEDBACK_ID_PARAM]: 'feedback-1',
  };

  it('coerces each param in validateSearch and drops invalid ones', () => {
    expect(
      parseAdminSearch({
        feedbackStatus: 'Closed,New',
        feedbackSubject: 'nope',
        feedbackOrg: 'Acme',
        feedbackOrder: 'sideways',
        feedbackPage: '2',
        feedbackLimit: 7,
      })
    ).toMatchObject({
      feedbackStatus: 'New,Closed',
      feedbackSubject: undefined,
      feedbackOrg: ['Acme'],
      feedbackOrder: undefined,
      feedbackPage: 2,
      feedbackLimit: undefined,
    });
  });

  it('keeps them on the feedback tab and drops them on a switch away', () => {
    expect(adminSearchForTab(feedbackSearch, 'feedback')).toMatchObject(feedbackSearch);

    const switched = adminSearchForTab(feedbackSearch, 'users');
    for (const key of Object.keys(feedbackSearch).filter(key => key !== 'tab')) {
      expect(switched[key as keyof typeof switched], key).toBeUndefined();
    }
  });
});
