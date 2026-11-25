import { describe, expect, it } from 'vitest';
import { CREDIT_ANALYSIS_TABS, creditTabSearchValue, parseCreditTab, parseSideApp } from './creditTabSearch';
import { parseAdminSearch } from '../adminTabParams';

describe('creditTab search param', () => {
  it.each(['margins', 'org-usage', 'api-usage', 'side-apps', 'elevenlabs', 'ledger', 'adjustments'])(
    'accepts %s',
    tab => {
      expect(parseCreditTab(tab)).toBe(tab);
      expect(parseAdminSearch({ creditTab: tab }).creditTab).toBe(tab);
    }
  );

  it.each(['nope', '', 42, undefined, null, 'constructor', 'economy', 'users'])('drops %s', value => {
    expect(parseCreditTab(value)).toBeUndefined();
    expect(parseAdminSearch({ creditTab: value }).creditTab).toBeUndefined();
  });

  it('keeps the default and economy out of the URL', () => {
    expect(creditTabSearchValue('users')).toBeUndefined();
    expect(creditTabSearchValue('economy')).toBeUndefined();
    expect(CREDIT_ANALYSIS_TABS.filter(tab => creditTabSearchValue(tab))).toHaveLength(7);
  });
});

describe('sideApp search param', () => {
  it.each(['b4m_my_app_0011aabb', 'a.b-c_D', 'x', 'a'.repeat(128)])('accepts %s', value => {
    expect(parseSideApp(value)).toBe(value);
    expect(parseAdminSearch({ sideApp: value }).sideApp).toBe(value);
  });

  it.each(['', 'a'.repeat(129), 'has space', 'a/b', 'a?b', '../x', 42, null, undefined, ['a']])('drops %s', value => {
    expect(parseSideApp(value)).toBeUndefined();
    expect(parseAdminSearch({ sideApp: value }).sideApp).toBeUndefined();
  });
});
