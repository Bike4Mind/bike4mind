import { describe, it, expect } from 'vitest';
import type { PremiumRouteDescriptor } from './premiumContract';
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
});
