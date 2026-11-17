import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import {
  DEFAULT_RATE_LIMITS_SEARCH_STATE,
  RATE_LIMITS_VIEWS,
  parseIsoDateTime,
  rateLimitsSearchEntries,
  readRateLimitsSearch,
} from './rateLimitsSearch';

describe('Rate Limits search params', () => {
  it('reads defaults from an empty search', () => {
    expect(readRateLimitsSearch({})).toEqual(DEFAULT_RATE_LIMITS_SEARCH_STATE);
  });

  it.each(RATE_LIMIT_INTEGRATIONS.flatMap(integration => RATE_LIMITS_VIEWS.map(view => [integration, view] as const)))(
    'round-trips %s on the %s view',
    (integration, view) => {
      const state = {
        dateFrom: '2026-11-10T08:00:00.000Z',
        dateTo: '2026-11-17T08:00:00.000Z',
        integration,
        throttledOnly: true,
        view,
      };
      expect(readRateLimitsSearch(rateLimitsSearchEntries(state))).toEqual(state);
    }
  );

  it('reads the boolean TanStack decodes and the string validateSearch hands on', () => {
    expect(readRateLimitsSearch({ rateThrottled: true }).throttledOnly).toBe(true);
    expect(readRateLimitsSearch({ rateThrottled: 'true' }).throttledOnly).toBe(true);
    expect(readRateLimitsSearch({ rateThrottled: 'yes' }).throttledOnly).toBe(false);
  });

  it('falls back to the defaults for invalid values', () => {
    expect(
      readRateLimitsSearch({
        rateFrom: 'yesterday',
        rateTo: '2026-02-30T00:00:00.000Z',
        rateIntegration: 'constructor',
        rateThrottled: 1,
        rateView: 'chart',
      })
    ).toEqual(DEFAULT_RATE_LIMITS_SEARCH_STATE);
    expect(readRateLimitsSearch({ rateIntegration: ['slack'], rateFrom: 1731830400000 })).toEqual(
      DEFAULT_RATE_LIMITS_SEARCH_STATE
    );
  });

  it('leaves every default out of the URL', () => {
    expect(rateLimitsSearchEntries(DEFAULT_RATE_LIMITS_SEARCH_STATE)).toEqual({
      rateFrom: undefined,
      rateTo: undefined,
      rateIntegration: undefined,
      rateThrottled: undefined,
      rateView: undefined,
    });
  });
});

describe('parseIsoDateTime', () => {
  it('normalizes a UTC timestamp to the toISOString form', () => {
    expect(parseIsoDateTime('2026-11-17T08:30Z')).toBe('2026-11-17T08:30:00.000Z');
    expect(parseIsoDateTime('2026-11-17T08:30:15.000Z')).toBe('2026-11-17T08:30:15.000Z');
  });

  it('rejects anything that is not a UTC timestamp', () => {
    for (const value of [
      '2026-11-17',
      '2026-11-17T08:30:00+09:00',
      '2026-13-01T00:00Z',
      '+275760-09-13T00:00:00.000Z',
      'now',
      42,
      null,
    ]) {
      expect(parseIsoDateTime(value), String(value)).toBeUndefined();
    }
  });
});
