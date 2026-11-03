import { describe, expect, it } from 'vitest';
import { parseSubscriptionDetailSearch } from './subscriptionDetailSearch';

describe('parseSubscriptionDetailSearch', () => {
  it('keeps a known non-default tab', () => {
    expect(parseSubscriptionDetailSearch({ tab: 'admin' })).toEqual({ tab: 'admin' });
  });

  it('leaves the default tab out of the URL', () => {
    expect(parseSubscriptionDetailSearch({ tab: 'overview' })).toEqual({ tab: undefined });
  });

  it('drops an unknown or non-string tab explicitly', () => {
    expect(parseSubscriptionDetailSearch({ tab: 'invoices' })).toEqual({ tab: undefined });
    expect(parseSubscriptionDetailSearch({ tab: 3 })).toEqual({ tab: undefined });
    expect(parseSubscriptionDetailSearch({})).toEqual({ tab: undefined });
  });
});
