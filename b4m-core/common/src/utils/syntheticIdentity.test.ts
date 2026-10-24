import { describe, it, expect } from 'vitest';
import { isSyntheticIdentity, parseSyntheticDomainList } from './syntheticIdentity';

describe('parseSyntheticDomainList', () => {
  it('splits on commas and whitespace, lower-cases, and drops a leading @', () => {
    expect(parseSyntheticDomainList(' Test.Example , @qa.example.org\nfoo.dev ')).toEqual([
      'test.example',
      'qa.example.org',
      'foo.dev',
    ]);
  });

  it('reads a wildcard or trailing-dot entry as the bare domain, so it is not silently inert', () => {
    expect(parseSyntheticDomainList('*.test.example, qa.example.org.')).toEqual(['test.example', 'qa.example.org']);
    expect(isSyntheticIdentity({ email: 'x@test.example' }, parseSyntheticDomainList('*.Test.Example'))).toBe(true);
  });

  it.each([undefined, null, 3, ''])('reads %s as no domains', raw => {
    expect(parseSyntheticDomainList(raw)).toEqual([]);
  });
});

describe('isSyntheticIdentity', () => {
  it('flags the persona- username prefix regardless of domains', () => {
    expect(isSyntheticIdentity({ username: 'persona-alice', email: 'a@real.com' }, [])).toBe(true);
    expect(isSyntheticIdentity({ username: 'Persona-Bob' }, [])).toBe(true);
  });

  it('flags a configured domain and its subdomains, not look-alikes', () => {
    const domains = ['test.example'];
    expect(isSyntheticIdentity({ username: 'u', email: 'x@test.example' }, domains)).toBe(true);
    expect(isSyntheticIdentity({ username: 'u', email: 'x@Sub.Test.Example' }, domains)).toBe(true);
    expect(isSyntheticIdentity({ username: 'u', email: 'x@nottest.example' }, domains)).toBe(false);
  });

  it('flags nothing by default (empty domain list)', () => {
    expect(isSyntheticIdentity({ username: 'alice', email: 'a@gmail.com' }, [])).toBe(false);
    expect(isSyntheticIdentity({ username: 'alice', email: null }, [])).toBe(false);
  });
});
