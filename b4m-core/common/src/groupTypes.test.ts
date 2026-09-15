import { describe, it, expect } from 'vitest';
import {
  GROUP_TYPE_CATALOG,
  KNOWN_GROUP_TYPE_KEYS,
  getGroupType,
  isKnownGroupType,
  unknownGroupTypeKeys,
} from './groupTypes';

describe('group type catalog', () => {
  it('exposes known keys matching the catalog', () => {
    expect(KNOWN_GROUP_TYPE_KEYS).toEqual(GROUP_TYPE_CATALOG.map(t => t.key));
    expect(KNOWN_GROUP_TYPE_KEYS).toContain('sales');
  });

  it('has unique keys and unique priorities', () => {
    const keys = GROUP_TYPE_CATALOG.map(t => t.key);
    const priorities = GROUP_TYPE_CATALOG.map(t => t.priority);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('resolves and validates keys', () => {
    expect(getGroupType('sales')?.label).toBe('Sales');
    expect(getGroupType('nope')).toBeUndefined();
    expect(isKnownGroupType('research')).toBe(true);
    expect(isKnownGroupType('research ')).toBe(false); // exact match, no trimming
  });

  it('reports unknown keys for defense-in-depth validation', () => {
    expect(unknownGroupTypeKeys(['sales', 'bogus', 'customer'])).toEqual(['bogus']);
    expect(unknownGroupTypeKeys(['sales'])).toEqual([]);
  });
});
