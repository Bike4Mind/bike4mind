import { describe, expect, it } from 'vitest';
import { CREDIT_ANALYSIS_TABS, creditTabSearchValue, parseCreditTab } from './creditTabSearch';
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
