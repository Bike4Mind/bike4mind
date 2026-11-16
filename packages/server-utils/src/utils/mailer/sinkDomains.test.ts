import { describe, it, expect } from 'vitest';
import { parseMailSinkDomains, findMailSinkDomain } from './sinkDomains';

describe('parseMailSinkDomains', () => {
  it.each([
    ['unset', undefined, []],
    ['empty', '', []],
    ['whitespace only', '  ', []],
    ['single', 'test.com', ['test.com']],
    ['multiple', 'test.com,example.test', ['test.com', 'example.test']],
    ['casing', 'Test.COM', ['test.com']],
    ['whitespace and empty entries', ' test.com , ,example.test ,', ['test.com', 'example.test']],
  ] as const)('%s', (_label, raw, expected) => {
    expect(parseMailSinkDomains(raw)).toEqual(expected);
  });
});

describe('findMailSinkDomain', () => {
  const sinks = parseMailSinkDomains('test.com, example.test');

  it('returns the matched domain for a listed recipient domain', () => {
    expect(findMailSinkDomain('alice-e2e@test.com', sinks)).toBe('test.com');
    expect(findMailSinkDomain('bob@example.test', sinks)).toBe('example.test');
  });

  it('matches case-insensitively', () => {
    expect(findMailSinkDomain('Alice@TEST.com', sinks)).toBe('test.com');
  });

  it('ignores surrounding whitespace on the address', () => {
    expect(findMailSinkDomain('  alice@test.com ', sinks)).toBe('test.com');
  });

  it('does not match a subdomain of a listed domain', () => {
    expect(findMailSinkDomain('alice@mail.test.com', sinks)).toBeUndefined();
  });

  it('does not substring-match a longer domain', () => {
    expect(findMailSinkDomain('alice@notest.com', sinks)).toBeUndefined();
    expect(findMailSinkDomain('alice@test.com.evil.example', sinks)).toBeUndefined();
  });

  it('returns undefined for an unlisted domain', () => {
    expect(findMailSinkDomain('alice@example.com', sinks)).toBeUndefined();
  });

  it('returns undefined when the list is empty', () => {
    expect(findMailSinkDomain('alice@test.com', [])).toBeUndefined();
  });

  it('returns undefined for an address with no domain', () => {
    expect(findMailSinkDomain('alice', sinks)).toBeUndefined();
    expect(findMailSinkDomain('alice@', sinks)).toBeUndefined();
    expect(findMailSinkDomain('', sinks)).toBeUndefined();
  });

  it('uses the last @ so a quoted local part with @ still resolves the domain', () => {
    expect(findMailSinkDomain('"a@b"@test.com', sinks)).toBe('test.com');
  });
});
