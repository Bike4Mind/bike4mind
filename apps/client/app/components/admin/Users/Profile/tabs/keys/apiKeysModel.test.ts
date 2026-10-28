import { describe, expect, it } from 'vitest';
import { API_KEY_ACCESS_BASES } from '@bike4mind/common';
import { apiErrorMessage, describeKeyAccess, maxWeeklyRequests, requestCounts } from './apiKeysModel';

describe('apiKeysModel', () => {
  it('explains every gate basis, and only the refusals are Blocked', () => {
    for (const basis of API_KEY_ACCESS_BASES) {
      const allowed = basis !== 'no_paid_subscription' && basis !== 'disabled';
      const described = describeKeyAccess({ mode: 'paid', allowed, basis });
      expect(described.label).toBe(allowed ? 'Allowed' : 'Blocked');
      expect(described.text.length).toBeGreaterThan(20);
    }
    expect(describeKeyAccess({ mode: 'paid', allowed: false, basis: 'no_paid_subscription' }).text).toContain(
      'Keys an admin generated for them still work.'
    );
  });

  it('reads request counts with zero for a key that made none', () => {
    const requests = { a: { last24h: 3, last7d: 30 }, b: { last24h: 0, last7d: 70 } };
    expect(requestCounts(requests, 'a')).toEqual({ last24h: 3, last7d: 30 });
    expect(requestCounts(requests, 'missing')).toEqual({ last24h: 0, last7d: 0 });
    expect(maxWeeklyRequests(requests)).toBe(70);
    expect(maxWeeklyRequests(undefined)).toBe(0);
  });

  it('prefers the server error text over the fallback', () => {
    expect(apiErrorMessage({ response: { data: { error: 'Too late' } } }, 'fallback')).toBe('Too late');
    expect(apiErrorMessage({ response: { data: { message: 'Nope' } } }, 'fallback')).toBe('Nope');
    expect(apiErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});
