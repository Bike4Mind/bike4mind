import { describe, expect, it } from 'vitest';
import { licenseKind } from './models';

describe('licenseKind', () => {
  it('is permissive only when every declared license is', () => {
    expect(licenseKind(['apache-2.0'])).toBe('permissive');
    expect(licenseKind(['MIT', 'bsd-3-clause'])).toBe('permissive');
    expect(licenseKind(['apache-2.0', 'gemma'])).toBe('restricted');
    expect(licenseKind(['apache-2.0', 'llama3'])).toBe('restricted');
    expect(licenseKind(['other'])).toBe('restricted');
    expect(licenseKind([])).toBe('restricted');
  });
});
