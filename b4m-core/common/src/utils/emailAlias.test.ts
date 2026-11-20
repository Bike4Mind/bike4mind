import { describe, expect, it } from 'vitest';
import { inboxAliasKey } from './emailAlias';

describe('inboxAliasKey', () => {
  it('lowercases and trims', () => {
    expect(inboxAliasKey('  Jane@Example.COM ')).toBe('jane@example.com');
  });

  it('drops a plus tag from the local part', () => {
    expect(inboxAliasKey('jane+invite@example.com')).toBe('jane@example.com');
  });

  it('ignores dots and folds googlemail.com for Gmail only', () => {
    expect(inboxAliasKey('j.a.n.e+x@googlemail.com')).toBe('jane@gmail.com');
    expect(inboxAliasKey('j.a.n.e@gmail.com')).toBe('jane@gmail.com');
    expect(inboxAliasKey('j.ane@example.com')).toBe('j.ane@example.com');
  });

  it('keeps different inboxes apart', () => {
    expect(inboxAliasKey('jane@example.com')).not.toBe(inboxAliasKey('june@example.com'));
    expect(inboxAliasKey('jane@example.com')).not.toBe(inboxAliasKey('jane@example.org'));
  });

  it('does not throw on empty or malformed input', () => {
    expect(() => inboxAliasKey('')).not.toThrow();
    expect(() => inboxAliasKey('nodomain')).not.toThrow();
    expect(() => inboxAliasKey('+@gmail.com')).not.toThrow();
  });
});
