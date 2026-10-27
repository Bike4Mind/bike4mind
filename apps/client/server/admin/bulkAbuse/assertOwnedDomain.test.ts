import { describe, expect, it } from 'vitest';
import { assertOwnedDomain } from './assertOwnedDomain';

describe('assertOwnedDomain', () => {
  it.each(['gmail.com', 'GMAIL.com', 'outlook.com', 'googlemail.com', 'fastmail.com', 'proton.me'])(
    'refuses the public mailbox provider %s',
    domain => {
      expect(() => assertOwnedDomain(domain)).toThrow(/Public mailbox provider/);
    }
  );

  it.each(['co.uk', 'github.io'])('refuses the public suffix %s', domain => {
    expect(() => assertOwnedDomain(domain)).toThrow(/public suffix/);
  });

  it('accepts an owned domain and its subdomains', () => {
    expect(assertOwnedDomain('kashre.com')).toBe('kashre.com');
    expect(assertOwnedDomain('mail.gmail.com')).toBe('mail.gmail.com');
  });

  it('refuses an invalid domain', () => {
    expect(() => assertOwnedDomain('')).toThrow(/Not a valid domain/);
  });
});
