// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerContributedViews, resetContributedViews } from '@bike4mind/common';
import { premiumNavigableViews } from '../premium-generated/premiumNavigableViews.generated';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@bike4mind/observability', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/observability')>()),
  Logger: { warn },
}));

const view = (name: string, overrides: Record<string, unknown> = {}) => ({
  id: `admin.ext.${name}`,
  section: 'admin',
  label: 'Example page',
  description: 'An example page used by tests',
  navigationType: 'route',
  target: `/admin/ext/${name}`,
  keywords: [],
  requiresAdmin: true,
  ...overrides,
});

// Loads the registration module against a stand-in for the generated contribution list, in a
// fresh module graph so its registry starts empty.
async function loadRegistrationWith(views: unknown[]) {
  vi.resetModules();
  vi.doMock('../premium-generated/premiumNavigableViews.generated', () => ({ premiumNavigableViews: views }));
  await import('./registerContributedViews');
  return import('@bike4mind/common');
}

describe('contributed navigation views', () => {
  it('no contributed view fails registration', () => {
    expect(registerContributedViews(premiumNavigableViews).rejected).toEqual([]);
    resetContributedViews();
  });
});

describe('registerContributedViews module', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  afterEach(() => {
    vi.doUnmock('../premium-generated/premiumNavigableViews.generated');
  });

  it('registers the generated contributions when it loads, without warning', async () => {
    const common = await loadRegistrationWith([view('first'), view('second')]);
    expect(common.getViewById('admin.ext.first')?.target).toBe('/admin/ext/first');
    expect(common.getViewById('admin.ext.second')?.target).toBe('/admin/ext/second');
    expect(warn).not.toHaveBeenCalled();
  });

  it('adds nothing and stays quiet when nothing is contributed', async () => {
    const common = await loadRegistrationWith([]);
    expect(common.getFilteredViews({ isAdmin: true })).toHaveLength(common.VIEW_REGISTRY.length);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per dropped list with the ids only', async () => {
    const common = await loadRegistrationWith([
      view('kept'),
      view('kept', { label: 'Other page' }),
      view('bad', { target: '/admin/users' }),
    ]);
    expect(common.getViewById('admin.ext.kept')?.label).toBe('Example page');
    expect(common.getViewById('admin.ext.bad')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already contributed'), { ids: ['admin.ext.kept'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed validation'), { ids: ['admin.ext.bad'] });
  });
});
