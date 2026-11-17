import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTEGRATION_HEALTH_TIME_RANGE,
  INTEGRATION_HEALTH_TIME_RANGES,
  INTEGRATION_NAMES,
  integrationHealthSearchEntries,
  readIntegrationHealthSearch,
} from './integrationHealthSearch';

describe('Integration Health search params', () => {
  it('reads defaults from an empty search', () => {
    expect(readIntegrationHealthSearch({})).toEqual({
      timeRange: DEFAULT_INTEGRATION_HEALTH_TIME_RANGE,
      expandedIntegration: null,
    });
  });

  it.each(
    INTEGRATION_HEALTH_TIME_RANGES.flatMap(timeRange => INTEGRATION_NAMES.map(name => [timeRange, name] as const))
  )('round-trips %s with %s expanded', (timeRange, expandedIntegration) => {
    const state = { timeRange, expandedIntegration };
    expect(readIntegrationHealthSearch(integrationHealthSearchEntries(state))).toEqual(state);
  });

  it('falls back to the defaults for invalid values', () => {
    expect(readIntegrationHealthSearch({ healthRange: '1y', healthIntegration: 'constructor' })).toEqual({
      timeRange: DEFAULT_INTEGRATION_HEALTH_TIME_RANGE,
      expandedIntegration: null,
    });
    expect(
      readIntegrationHealthSearch({ healthRange: 7, healthIntegration: ['slack'] }).expandedIntegration
    ).toBeNull();
  });

  it('leaves the default range and a collapsed list out of the URL', () => {
    expect(
      integrationHealthSearchEntries({ timeRange: DEFAULT_INTEGRATION_HEALTH_TIME_RANGE, expandedIntegration: null })
    ).toEqual({ healthRange: undefined, healthIntegration: undefined });
  });
});
