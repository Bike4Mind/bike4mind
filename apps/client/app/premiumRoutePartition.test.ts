import { describe, it, expect } from 'vitest';
import { WORKSPACE_SURFACES } from '@bike4mind/common';
import type { PremiumRouteDescriptor } from './premiumContract';
import { isAdminExtPath } from './components/admin/adminExtPath';
import { partitionPremiumRoutes } from './premiumRoutePartition';

const lazyImport = () => Promise.resolve({ default: () => null });
const route = (over: Partial<PremiumRouteDescriptor>): PremiumRouteDescriptor => ({ path: '/x', lazyImport, ...over });

describe('partitionPremiumRoutes', () => {
  it('splits public, standalone and app-shell routes', () => {
    const pub = route({ path: '/x/a/$token', public: true });
    const standalone = route({ path: '/x/$id', requireEntitlement: 'x:pro' });
    const shell = route({ path: '/x', appShell: true, requireFeatureTag: 'X' });
    const parts = partitionPremiumRoutes([pub, standalone, shell]);
    expect(parts.public).toEqual([pub]);
    expect(parts.standalone).toEqual([standalone]);
    expect(parts.appShell).toEqual([shell]);
  });

  it('treats an omitted public flag as gated', () => {
    const parts = partitionPremiumRoutes([route({ path: '/x' })]);
    expect(parts.public).toEqual([]);
    expect(parts.standalone).toHaveLength(1);
  });

  it.each([
    ['requireEntitlement', { requireEntitlement: 'x:pro' }],
    ['requireFeatureTag', { requireFeatureTag: 'X' }],
    ['fallbackPath', { fallbackPath: '/x' }],
  ])('refuses a public route with %s', (_name, gate) => {
    expect(() => partitionPremiumRoutes([route({ public: true, ...gate })])).toThrow(/public and gated/);
  });

  it('refuses a public app-shell route', () => {
    expect(() => partitionPremiumRoutes([route({ public: true, appShell: true })])).toThrow(/public and appShell/);
  });

  it('refuses a route that hosts a workspace list outside the app shell', () => {
    expect(() => partitionPremiumRoutes([route({ hostsWorkspace: 'space' })])).toThrow(
      /hostsWorkspace without appShell/
    );
    expect(() => partitionPremiumRoutes([route({ public: true, hostsWorkspace: 'space' })])).toThrow(
      /hostsWorkspace without appShell/
    );
  });

  it('accepts an app-shell route that hosts a workspace list', () => {
    const shell = route({ appShell: true, hostsWorkspace: 'space' });
    expect(partitionPremiumRoutes([shell]).appShell).toEqual([shell]);
  });

  it('refuses an admin dashboard card on a parameterised path', () => {
    expect(() =>
      partitionPremiumRoutes([
        route({ path: '/x/$id', adminDashboard: { label: 'X', description: 'Example dashboard.' } }),
      ])
    ).toThrow(/adminDashboard on a parameterised path/);
  });

  it('accepts an admin dashboard card on a concrete path', () => {
    const dashboard = route({ path: '/x/stats', adminDashboard: { label: 'X', description: 'Example dashboard.' } });
    expect(partitionPremiumRoutes([dashboard]).standalone).toEqual([dashboard]);
  });
});

describe('partitionPremiumRoutes admin pages', () => {
  const adminPage = { section: 'platform', label: 'Reports' } as const;
  const page = (over: Partial<PremiumRouteDescriptor> = {}) =>
    route({ path: '/admin/ext/reports', adminPage, ...over });

  it('puts an admin page in the admin bucket only, in the order given', () => {
    const first = page();
    const second = page({ path: '/admin/ext/audits', adminPage: { section: 'trust', label: 'Audits' } });
    const standalone = route({ path: '/x/$id', requireEntitlement: 'x:pro' });
    const parts = partitionPremiumRoutes([first, standalone, second]);
    expect(parts.admin).toEqual([first, second]);
    expect(parts.standalone).toEqual([standalone]);
    expect(parts.public).toEqual([]);
    expect(parts.appShell).toEqual([]);
  });

  it('leaves the other buckets as they were for descriptors without adminPage', () => {
    const pub = route({ path: '/x/a/$token', public: true });
    const standalone = route({ path: '/x/$id', requireEntitlement: 'x:pro' });
    const shell = route({ path: '/x', appShell: true, edgeToEdge: true });
    const parts = partitionPremiumRoutes([pub, standalone, shell]);
    expect(parts).toEqual({ public: [pub], standalone: [standalone], appShell: [shell], admin: [] });
  });

  it('returns an empty admin bucket for no descriptors', () => {
    expect(partitionPremiumRoutes([])).toEqual({ public: [], standalone: [], appShell: [], admin: [] });
  });

  it.each(['/x/reports', '/admin', '/admin/reports', '/admin/ext', '/admin/ext/', '/administrator/ext/reports'])(
    'refuses adminPage on %s, which is not under /admin/ext/<name>',
    path => {
      expect(() => partitionPremiumRoutes([page({ path })])).toThrow(/adminPage outside \/admin\/ext\//);
    }
  );

  it('refuses adminPage on a parameterised path', () => {
    expect(() => partitionPremiumRoutes([page({ path: '/admin/ext/reports/$id' })])).toThrow(
      /adminPage on a parameterised path/
    );
    expect(() => partitionPremiumRoutes([page({ path: '/admin/ext/$' })])).toThrow(/parameterised path/);
  });

  it.each([
    ['public', { public: true }],
    ['appShell', { appShell: true }],
    ['edgeToEdge', { edgeToEdge: true }],
    ['hostsWorkspace', { hostsWorkspace: 'space' }],
    ['adminDashboard', { adminDashboard: { label: 'X', description: 'Example dashboard.' } }],
    ['requireEntitlement', { requireEntitlement: 'x:pro' }],
    ['requireFeatureTag', { requireFeatureTag: 'X' }],
    ['fallbackPath', { fallbackPath: '/x' }],
  ])('refuses adminPage together with %s', (field, over) => {
    expect(() => partitionPremiumRoutes([page(over)])).toThrow(
      new RegExp(`/admin/ext/reports sets adminPage together with ${field}`)
    );
  });

  it('names every conflicting field at once', () => {
    expect(() => partitionPremiumRoutes([page({ appShell: true, requireFeatureTag: 'X' })])).toThrow(
      /together with appShell, requireFeatureTag/
    );
  });

  it('accepts a flag that is explicitly false', () => {
    const explicit = page({ public: false, appShell: false, edgeToEdge: false });
    expect(partitionPremiumRoutes([explicit]).admin).toEqual([explicit]);
  });

  it('refuses an unknown section', () => {
    const unknown = { section: 'nope', label: 'Reports' } as unknown as PremiumRouteDescriptor['adminPage'];
    expect(() => partitionPremiumRoutes([page({ adminPage: unknown })])).toThrow(/unknown section/);
  });

  it.each(['', '   '])('refuses a blank label (%j)', label => {
    expect(() => partitionPremiumRoutes([page({ adminPage: { ...adminPage, label } })])).toThrow(/without a label/);
  });

  it('refuses a label that is not a string', () => {
    const bad = { ...adminPage, label: 5 } as unknown as PremiumRouteDescriptor['adminPage'];
    expect(() => partitionPremiumRoutes([page({ adminPage: bad })])).toThrow(/without a label/);
  });

  it('refuses two admin pages on one path', () => {
    expect(() => partitionPremiumRoutes([page(), page()])).toThrow(/declared twice with adminPage/);
  });

  it('refuses two admin pages whose paths differ only in letter case', () => {
    expect(() => partitionPremiumRoutes([page(), page({ path: '/admin/ext/Reports' })])).toThrow(
      /declared twice with adminPage/
    );
  });

  it.each(['/admin/ext/a//b', '/admin/ext/a/', '/admin/ext/../x', '/admin/ext/./x', '/admin/ext//x'])(
    'refuses adminPage on %s, which has an empty, "." or ".." segment',
    path => {
      expect(() => partitionPremiumRoutes([page({ path })])).toThrow(/empty, "\." or "\.\." segment/);
    }
  );

  it('refuses two admin pages that derive the same sidebar test id', () => {
    expect(() =>
      partitionPremiumRoutes([page({ path: '/admin/ext/foo-bar' }), page({ path: '/admin/ext/foo/bar' })])
    ).toThrow(/test id admin-ext-foo-bar-btn is already taken/);
  });

  it('accepts two admin pages when an explicit test id tells them apart', () => {
    const first = page({ path: '/admin/ext/foo-bar' });
    const second = page({ path: '/admin/ext/foo/bar', adminPage: { ...adminPage, testId: 'other-btn' } });
    expect(partitionPremiumRoutes([first, second]).admin).toEqual([first, second]);
  });

  it.each([
    '/admin',
    '/admin/',
    '/admin/ext/reports',
    '/admin/users/$userId',
    '/Admin/Reports',
    'admin/users/$userId',
    '//admin/x',
  ])('refuses a route without adminPage on %s', path => {
    expect(() => partitionPremiumRoutes([route({ path })])).toThrow(/under \/admin without adminPage/);
    expect(() => partitionPremiumRoutes([route({ path, public: true })])).toThrow(/under \/admin without adminPage/);
  });

  it('does not treat a sibling prefix as the admin URL space', () => {
    const sibling = route({ path: '/administrator/tools' });
    expect(partitionPremiumRoutes([sibling]).standalone).toEqual([sibling]);
  });
});

describe('isAdminExtPath', () => {
  it('matches the contributed page namespace in any letter case, and nothing else', () => {
    expect(isAdminExtPath('/admin/ext/reports')).toBe(true);
    expect(isAdminExtPath('/Admin/EXT/reports')).toBe(true);
    expect(isAdminExtPath('/admin/ext')).toBe(false);
    expect(isAdminExtPath('/admin')).toBe(false);
    expect(isAdminExtPath('/admin/users/abc')).toBe(false);
    expect(isAdminExtPath('/administrator/ext/x')).toBe(false);
  });
});

describe('the admin URL space', () => {
  it('holds no registered workspace route, so no workspace lookup by path prefix can match an admin page', () => {
    for (const surface of WORKSPACE_SURFACES) {
      expect(isAdminExtPath(surface.routePrefix)).toBe(false);
      expect(surface.routePrefix.toLowerCase().startsWith('/admin')).toBe(false);
    }
  });
});
