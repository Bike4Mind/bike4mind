import { describe, expect, it } from 'vitest';
import { filterVisiblePremiumNavItems, premiumNavItemForRedirect } from './premiumNav';
import type { PremiumNavDescriptor } from '@client/app/premiumContract';

const item = (overrides: Partial<PremiumNavDescriptor> = {}): PremiumNavDescriptor => ({
  path: '/product/home',
  label: 'Product',
  ...overrides,
});

describe('filterVisiblePremiumNavItems', () => {
  it('shows an ungated item to everyone', () => {
    expect(filterVisiblePremiumNavItems([item()], [], [])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([item()], undefined, undefined)).toHaveLength(1);
  });

  it('shows an entitlement-gated item only to holders', () => {
    const gated = item({ requireEntitlement: 'product:pro' });
    expect(filterVisiblePremiumNavItems([gated], ['product:pro'], [])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([gated], ['other:pro'], [])).toHaveLength(0);
    expect(filterVisiblePremiumNavItems([gated], [], [])).toHaveLength(0);
  });

  it('hides a gated item while entitlements are still loading (undefined) — no flash', () => {
    const gated = item({ requireEntitlement: 'product:pro' });
    expect(filterVisiblePremiumNavItems([gated], undefined, [])).toHaveLength(0);
  });

  it('normalizes the entitlement key (mixed case/whitespace descriptor still matches)', () => {
    const gated = item({ requireEntitlement: ' Product:PRO ' });
    expect(filterVisiblePremiumNavItems([gated], ['product:pro'], [])).toHaveLength(1);
  });

  it('matches feature tags case-insensitively', () => {
    const gated = item({ requireFeatureTag: 'Opti' });
    expect(filterVisiblePremiumNavItems([gated], [], ['opti'])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([gated], [], ['OPTI'])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([gated], [], ['other'])).toHaveLength(0);
    expect(filterVisiblePremiumNavItems([gated], [], null)).toHaveLength(0);
  });

  it('ORs the gates when both are set — either one grants', () => {
    const gated = item({ requireEntitlement: 'product:pro', requireFeatureTag: 'Product' });
    expect(filterVisiblePremiumNavItems([gated], ['product:pro'], [])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([gated], [], ['product'])).toHaveLength(1);
    expect(filterVisiblePremiumNavItems([gated], [], [])).toHaveLength(0);
  });

  it('filters per item, preserving order', () => {
    const open = item({ path: '/a', label: 'A' });
    const denied = item({ path: '/b', label: 'B', requireEntitlement: 'b:pro' });
    const granted = item({ path: '/c', label: 'C', requireEntitlement: 'c:pro' });
    const visible = filterVisiblePremiumNavItems([open, denied, granted], ['c:pro'], []);
    expect(visible.map(i => i.path)).toEqual(['/a', '/c']);
  });

  // The strict no-bypass rule is structural: the filter's signature takes only
  // entitlements + tags, so admin/developer status CANNOT influence visibility.
  // (The route gate, by contrast, bypasses for admins - see RestrictedPage.)
});

describe('premiumNavItemForRedirect', () => {
  const product = item({ path: '/product', label: 'Product' });
  const reports = item({ path: '/product/reports', label: 'Reports' });

  it('matches the path itself and anything under it, ignoring the query and hash', () => {
    for (const to of ['/product', '/product/', '/product/run/42', '/product?tab=new', '/product#top']) {
      expect(premiumNavItemForRedirect([product], to)?.label).toBe('Product');
    }
  });

  it('matches only on a segment boundary', () => {
    expect(premiumNavItemForRedirect([product], '/productivity')).toBeUndefined();
    expect(premiumNavItemForRedirect([product], '/other/product')).toBeUndefined();
  });

  it('takes the longest matching path, whatever the order', () => {
    expect(premiumNavItemForRedirect([product, reports], '/product/reports/7')?.label).toBe('Reports');
    expect(premiumNavItemForRedirect([reports, product], '/product/reports/7')?.label).toBe('Reports');
    expect(premiumNavItemForRedirect([reports, product], '/product/run')?.label).toBe('Product');
  });

  it('ignores visibility gates (the visitor is signed out)', () => {
    const gated = item({ path: '/product', requireEntitlement: 'product:pro', requireFeatureTag: 'beta' });
    expect(premiumNavItemForRedirect([gated], '/product')).toBe(gated);
  });

  it('never treats a root or trailing-slash item path as a catch-all', () => {
    expect(premiumNavItemForRedirect([item({ path: '/' })], '/anything')).toBeUndefined();
    expect(premiumNavItemForRedirect([item({ path: '/product/' })], '/product/x')?.path).toBe('/product/');
  });

  it('gives undefined for a missing, unsafe or unmatched redirect', () => {
    for (const to of [
      null,
      undefined,
      '',
      '/',
      '//product',
      '/\\product',
      'https://evil.test/product',
      '/login',
      '/other',
      '/product/x\u2028y',
    ]) {
      expect(premiumNavItemForRedirect([product], to)).toBeUndefined();
    }
    expect(premiumNavItemForRedirect([], '/product')).toBeUndefined();
  });
});
