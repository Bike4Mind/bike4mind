import { describe, it, expect } from 'vitest';
import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  AUDIT_ENTRY_ID_PARAM,
  FEEDBACK_ID_PARAM,
  MODERATION_INCIDENT_ID_PARAM,
} from '@bike4mind/common';
import { ADMIN_GLOBAL_PARAMS, ADMIN_TAB_PARAMS, adminSearchForTab, parseAdminSearch } from './adminTabParams';
import { adminTabFromSlug } from './adminTabSlugs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SHADOW_DETECTION_SEARCH_KEYS } from './shadowDetectionSearch';
import { SIGNUP_RISK_REVIEW_SEARCH_KEYS } from './signupRiskReviewSearch';
import { SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS } from './signupDomainHoldsSearch';
import { EVENTS_SEARCH_KEYS } from './EventMetrics/eventsTabSearch';
import { INTEGRATION_DEMAND_SEARCH_KEYS } from './integrationDemandSearch';
import { ANALYTICS_SEARCH_KEYS } from './Analytics/analyticsTabSearch';
import { STRIPE_DISPUTE_SEARCH_KEYS } from './stripeDisputeSearch';
import type { AdminListSearchKeys } from './shared/useAdminListUrlState';

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
        [FEEDBACK_ID_PARAM]: 'bbbbbbbbbbbbbbbbbbbbbbbb',
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

  it('drops an invalid users view param on another tab instead of adding a default page', () => {
    expect(parseAdminSearch({ tab: 'feedback', status: 'open' }).page).toBeUndefined();
    expect(parseAdminSearch({ tab: 'organizations', sort: 'bogus' }).page).toBeUndefined();
  });

  it('treats a link with no tab as the Users tab, the console default', () => {
    expect(parseAdminSearch({ sort: 'bogus' }).page).toBe(1);
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

describe('Users tab analytics drill-down params', () => {
  const drillDown = {
    tab: 'users',
    page: 1,
    createdFrom: '2026-10-01T00:00:00.000Z',
    createdTo: '2026-11-01T00:00:00.000Z',
    verdict: 'suspected',
    funnelStep: 'firstAction',
    activeFrom: '2026-10-03',
    activeTo: '2026-10-03',
  };

  it('keeps each key through validateSearch and drops an invalid one', () => {
    expect(parseAdminSearch(drillDown)).toMatchObject(drillDown);
    expect(
      parseAdminSearch({ tab: 'users', verdict: 'maybe', funnelStep: 'bought', activeFrom: '2026-13-01', activeTo: 7 })
    ).toMatchObject({ verdict: undefined, funnelStep: undefined, activeFrom: undefined, activeTo: undefined });
  });

  it('keeps them on the users tab and drops them on a switch away', () => {
    expect(adminSearchForTab(parseAdminSearch(drillDown), 'users')).toMatchObject(drillDown);
    const switched = adminSearchForTab(parseAdminSearch(drillDown), 'admin-settings');
    for (const key of ['verdict', 'funnelStep', 'activeFrom', 'activeTo'] as const) {
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
    [FEEDBACK_ID_PARAM]: 'bbbbbbbbbbbbbbbbbbbbbbbb',
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

describe('record id params', () => {
  const objectId = 'aBcDeF0123456789aBcDeF01';
  const idParams = [FEEDBACK_ID_PARAM, AUDIT_ENTRY_ID_PARAM, MODERATION_INCIDENT_ID_PARAM] as const;

  it.each(idParams)('accepts a %s that is an ObjectId, normalized to lower case', key => {
    expect(parseAdminSearch({ [key]: objectId })[key]).toBe(objectId.toLowerCase());
  });

  it.each(idParams)('drops a %s that is not an ObjectId', key => {
    for (const value of ['../admin/x?y=', 'summary', 'feedback-1', `${objectId}0`, 42, ['x']]) {
      expect(parseAdminSearch({ [key]: value })[key], String(value)).toBeUndefined();
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

describe('Subscriptions tab params', () => {
  it('keeps the default page when every view param is invalid, so the URL still describes a view', () => {
    expect(parseAdminSearch({ tab: 'subscriptions', subsSort: 'bogus', subsLimit: 7 })).toMatchObject({
      subsPage: 1,
      subsSort: undefined,
      subsLimit: undefined,
    });
  });

  it('drops an invalid subscriptions view param on another tab instead of adding a default page', () => {
    expect(parseAdminSearch({ tab: 'users', subsSort: 'bogus' }).subsPage).toBeUndefined();
  });
});

describe('invite center section param', () => {
  it('is parsed by parseAdminSearch', () => {
    expect(parseAdminSearch({ tab: 'waitlist', inviteSection: 'pending' }).inviteSection).toBe('pending');
  });

  it('drops an unknown section in validateSearch', () => {
    expect(parseAdminSearch({ tab: 'waitlist', inviteSection: 'nope' }).inviteSection).toBeUndefined();
  });

  it('is kept on the waitlist tab and dropped on a switch away', () => {
    const previous = { tab: 'waitlist', inviteSection: 'pending' };
    expect(adminSearchForTab(previous, 'waitlist')).toMatchObject({ tab: 'waitlist', inviteSection: 'pending' });
    expect(adminSearchForTab(previous, 'users').inviteSection).toBeUndefined();
  });
});

describe('Security tab params', () => {
  const securitySearch = {
    tab: 'security-dashboard',
    securityView: 'scans',
    securityScan: 'prowler',
    securityRange: '7d',
  };

  it('registers the view, scan and range params on the security tab only', () => {
    expect(ADMIN_TAB_PARAMS['security-dashboard']).toEqual(['securityView', 'securityScan', 'securityRange']);
    const owners = Object.entries(ADMIN_TAB_PARAMS).filter(([, params]) =>
      (params as readonly string[]).some(
        param => param === 'securityView' || param === 'securityScan' || param === 'securityRange'
      )
    );
    expect(owners.map(([slug]) => slug)).toEqual(['security-dashboard']);
  });

  it('coerces each param in validateSearch and drops invalid ones', () => {
    expect(parseAdminSearch(securitySearch)).toMatchObject(securitySearch);
    expect(parseAdminSearch({ securityView: 'overview', securityScan: 'code', securityRange: '30d' })).toMatchObject({
      securityView: undefined,
      securityScan: undefined,
      securityRange: undefined,
    });
  });

  it('keeps them on the security tab and drops them on a switch away', () => {
    expect(adminSearchForTab(securitySearch, 'security-dashboard')).toMatchObject(securitySearch);
    const switched = adminSearchForTab(securitySearch, 'users');
    expect(switched.securityView).toBeUndefined();
    expect(switched.securityScan).toBeUndefined();
    expect(switched.securityRange).toBeUndefined();
  });
});

describe('useAdminListUrlState keys', () => {
  // Every key set passed to useAdminListUrlState, by the name its caller imports it under.
  const LIST_SEARCH_KEYS: Readonly<Record<string, AdminListSearchKeys>> = {
    SHADOW_DETECTION_SEARCH_KEYS,
    SIGNUP_RISK_REVIEW_SEARCH_KEYS,
    SIGNUP_DOMAIN_HOLDS_SEARCH_KEYS,
    EVENTS_SEARCH_KEYS,
    INTEGRATION_DEMAND_SEARCH_KEYS,
    ANALYTICS_SEARCH_KEYS,
    STRIPE_DISPUTE_SEARCH_KEYS,
  };
  // Left out of the registry on purpose, so validateSearch strips them: free-text searches that can
  // hold personal data, saved-view names that are not shareable yet, and query/view keys a tab never writes.
  const PRIVATE_KEYS = new Set([
    'detectionQuery',
    'detectionView',
    'riskQuery',
    'riskView',
    'holdQuery',
    'holdView',
    'eventsQuery',
    'eventsSavedView',
    'analyticsQuery',
    'analyticsView',
    'disputeQuery',
    'disputeView',
  ]);
  const registered = new Set<string>(Object.values(ADMIN_TAB_PARAMS).flat());

  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it('knows every key set a caller passes', () => {
    const callers = sourceFiles(__dirname).flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(/useAdminListUrlState\((\w+)\)/g)].map(match => ({
        file: relative(__dirname, file),
        keys: match[1],
      }))
    );
    expect(callers.length).toBeGreaterThan(0);
    for (const { file, keys } of callers) expect(LIST_SEARCH_KEYS, file).toHaveProperty(keys);
  });

  it('registers each key or lists it as deliberately private', () => {
    for (const [name, keys] of Object.entries(LIST_SEARCH_KEYS)) {
      for (const key of [keys.query, keys.view, ...Object.values(keys.filters)]) {
        expect(registered.has(key) || PRIVATE_KEYS.has(key), `${name}: ${key}`).toBe(true);
      }
    }
  });

  it('never registers a key it lists as private', () => {
    for (const key of PRIVATE_KEYS) expect(registered.has(key), key).toBe(false);
  });
});
