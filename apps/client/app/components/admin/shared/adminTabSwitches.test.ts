import { describe, expect, it } from 'vitest';
import { leavesAdminSettingsPage } from './adminTabSwitches';

const at = (pathname: string, search: object) => ({ pathname, search });

describe('leavesAdminSettingsPage', () => {
  it('leaves when the path changes, even with the same tab', () => {
    expect(
      leavesAdminSettingsPage(at('/admin', { tab: 'sec-ops-triage' }), at('/new', { tab: 'sec-ops-triage' }))
    ).toBe(true);
    expect(leavesAdminSettingsPage(at('/admin', {}), at('/new', {}))).toBe(true);
  });

  it('leaves when the admin tab changes, including to or from no tab', () => {
    expect(leavesAdminSettingsPage(at('/admin', { tab: 'sec-ops-triage' }), at('/admin', { tab: 'users' }))).toBe(true);
    expect(leavesAdminSettingsPage(at('/admin', {}), at('/admin', { tab: 'users' }))).toBe(true);
  });

  it('stays when only other search params change', () => {
    expect(
      leavesAdminSettingsPage(at('/admin', { tab: 'settings' }), at('/admin', { tab: 'settings', q: 'limit' }))
    ).toBe(false);
    expect(leavesAdminSettingsPage(at('/admin', {}), at('/admin', { q: 'limit' }))).toBe(false);
  });
});
