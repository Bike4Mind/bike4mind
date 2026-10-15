import { describe, it, expect } from 'vitest';
import {
  INTEGRATIONS_PAGE_SOURCES,
  INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH,
  IntegrationsEvents,
  isIntegrationsPageSource,
  normalizeIntegrationsSearchQuery,
} from '../integrations';

describe('IntegrationsEvents', () => {
  it('names every event distinctly, and prefixes every key so a merged registry cannot lose one', () => {
    const values = Object.values(IntegrationsEvents);
    expect(new Set(values).size).toBe(values.length);
    for (const key of Object.keys(IntegrationsEvents)) expect(key.startsWith('INTEGRATIONS_')).toBe(true);
  });
});

describe('isIntegrationsPageSource', () => {
  it.each([...INTEGRATIONS_PAGE_SOURCES])('accepts %s', source => {
    expect(isIntegrationsPageSource(source)).toBe(true);
  });

  it.each([undefined, null, '', 'PROFILE_MENU', 'newsletter', 42, ['profile_menu']])('rejects %o', value => {
    expect(isIntegrationsPageSource(value)).toBe(false);
  });
});

describe('normalizeIntegrationsSearchQuery', () => {
  it('trims and lowercases', () => {
    expect(normalizeIntegrationsSearchQuery('  HubSpot CRM \n')).toBe('hubspot crm');
  });

  it('caps the query, and leaves no trailing space where the cap lands on one', () => {
    const long = `${'a'.repeat(INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH - 1)} ${'b'.repeat(100)}`;
    const normalized = normalizeIntegrationsSearchQuery(long);
    expect(normalized).toBe('a'.repeat(INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH - 1));
    expect(normalizeIntegrationsSearchQuery('x'.repeat(200))).toHaveLength(INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH);
  });

  it('reduces whitespace alone to an empty query', () => {
    expect(normalizeIntegrationsSearchQuery('   ')).toBe('');
  });
});
