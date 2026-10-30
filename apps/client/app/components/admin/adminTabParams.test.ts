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
    limit: 50,
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

  it('keeps the default page when every view param is invalid, so the URL still describes a view', () => {
    expect(parseAdminSearch({ tab: 'users', limit: 7, sort: 'bogus' })).toMatchObject({
      page: 1,
      limit: undefined,
      sort: undefined,
    });
    expect(parseAdminSearch({ tab: 'users', userId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).page).toBeUndefined();
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

describe('Webhook Audit Logs and Model Logs tab params', () => {
  const webhookSearch = {
    tab: 'webhook-audit-logs',
    webhookRange: '30d',
    webhookRepo: 'acme/widgets',
    webhookEvent: 'push',
    webhookStatus: 'failed',
    webhookSource: 'org',
    webhookDeliveryId: '8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a',
  };
  const modelLogsSearch = {
    tab: 'model-logs',
    modelLogsPage: 2,
    modelLogsLimit: 25,
    modelLogsFrom: '2026-09-01',
    modelLogsTo: '2026-09-30',
    modelLogsModel: 'gpt-4',
  };

  it('coerces each param in validateSearch and drops invalid ones', () => {
    expect(
      parseAdminSearch({ webhookRange: '1y', webhookDeliveryId: '../x', modelLogsLimit: '25', modelLogsFrom: 'soon' })
    ).toMatchObject({
      webhookRange: undefined,
      webhookDeliveryId: undefined,
      modelLogsLimit: 25,
      modelLogsFrom: undefined,
    });
  });

  it('never accepts the model logs free-text search', () => {
    expect(parseAdminSearch({ search: 'my prompt' })).not.toHaveProperty('search');
  });

  it.each([
    ['webhook-audit-logs', webhookSearch, 'model-logs'],
    ['model-logs', modelLogsSearch, 'webhook-audit-logs'],
  ] as const)('keeps %s params on their tab and drops them on a switch away', (slug, search, otherSlug) => {
    expect(adminSearchForTab(search, slug)).toMatchObject(search);

    const switched = adminSearchForTab(search, otherSlug);
    for (const key of Object.keys(search).filter(key => key !== 'tab')) {
      expect(switched[key as keyof typeof switched], key).toBeUndefined();
    }
  });
});

describe('Organizations tab params', () => {
  const organizationsSearch = {
    tab: 'organizations',
    orgsPage: 2,
    orgsLimit: 20,
    orgsSort: 'createdAt',
    orgsOrder: 'desc',
    orgsPersonal: false,
    orgId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  };

  it('coerces each param in validateSearch and drops invalid ones', () => {
    expect(
      parseAdminSearch({ orgsPage: '2', orgsLimit: 7, orgsSort: 'credits', orgsPersonal: 'true', orgId: '../x' })
    ).toMatchObject({
      orgsPage: 2,
      orgsLimit: undefined,
      orgsSort: undefined,
      orgsPersonal: true,
      orgId: undefined,
    });
  });

  it('keeps the default page when every view param is invalid, so the URL still describes a view', () => {
    expect(parseAdminSearch({ tab: 'organizations', orgsSort: 'credits', orgsLimit: 7 })).toMatchObject({
      orgsPage: 1,
      orgsLimit: undefined,
      orgsSort: undefined,
    });
    expect(parseAdminSearch({ tab: 'organizations', orgId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }).orgsPage).toBeUndefined();
  });

  it('drops an invalid orgs view param on another tab instead of adding a default page', () => {
    expect(parseAdminSearch({ tab: 'users', orgsSort: 'credits' }).orgsPage).toBeUndefined();
  });

  it('keeps them on the organizations tab and drops them on a switch away', () => {
    expect(adminSearchForTab(organizationsSearch, 'organizations')).toMatchObject(organizationsSearch);

    const switched = adminSearchForTab(organizationsSearch, 'users');
    for (const key of Object.keys(organizationsSearch).filter(key => key !== 'tab')) {
      expect(switched[key as keyof typeof switched], key).toBeUndefined();
    }
  });
});
