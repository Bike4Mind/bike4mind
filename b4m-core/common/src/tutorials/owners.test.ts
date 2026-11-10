import { describe, expect, it } from 'vitest';
import { assertTutorialOwners } from './owners';

const ok = { owner: 'alpha', label: 'Alpha', adminBase: '/api/premium-alpha/tutorial', adminHref: '/alpha?mode=admin' };

describe('assertTutorialOwners', () => {
  it('passes a well-formed list through, and an empty one', () => {
    expect(assertTutorialOwners([ok])).toEqual([ok]);
    expect(assertTutorialOwners([])).toEqual([]);
  });

  it('throws on an adminBase outside /api/', () => {
    expect(() => assertTutorialOwners([{ ...ok, adminBase: 'https://evil.example/api/' }])).toThrow(/adminBase/);
    expect(() => assertTutorialOwners([{ ...ok, adminBase: '/other/x' }])).toThrow(/adminBase/);
  });

  it('throws on an adminHref that is not a local path', () => {
    expect(() => assertTutorialOwners([{ ...ok, adminHref: 'alpha' }])).toThrow(/adminHref/);
    expect(() => assertTutorialOwners([{ ...ok, adminHref: '//evil.example' }])).toThrow(/adminHref/);
  });

  it('throws on a duplicate owner or a missing label', () => {
    expect(() => assertTutorialOwners([ok, ok])).toThrow(/duplicate/);
    expect(() => assertTutorialOwners([{ ...ok, label: '' }])).toThrow(/label/);
  });
});
