import { describe, expect, it } from 'vitest';
import { narrowsToNotebooks, toSessionListFilters } from './sidenavFilters';

describe('toSessionListFilters', () => {
  it('returns undefined for the defaults, so the default list request is unchanged', () => {
    expect(toSessionListFilters('all', 'all')).toBeUndefined();
  });

  it('maps content and origin choices to server filters', () => {
    expect(toSessionListFilters('images', 'all')).toEqual({ hasImages: true });
    expect(toSessionListFilters('chats', 'all')).toEqual({ hasImages: false });
    expect(toSessionListFilters('all', 'onlyApi')).toEqual({ origin: 'api' });
    expect(toSessionListFilters('all', 'hideApi')).toEqual({ excludeOrigin: 'api' });
    expect(toSessionListFilters('images', 'hideApi')).toEqual({ hasImages: true, excludeOrigin: 'api' });
  });
});

describe('narrowsToNotebooks', () => {
  it('hides projects and agents only for choices they cannot match', () => {
    expect(narrowsToNotebooks('all', 'all')).toBe(false);
    expect(narrowsToNotebooks('all', 'hideApi')).toBe(false);
    expect(narrowsToNotebooks('all', 'onlyApi')).toBe(true);
    expect(narrowsToNotebooks('images', 'all')).toBe(true);
    expect(narrowsToNotebooks('chats', 'hideApi')).toBe(true);
  });
});
