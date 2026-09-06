import { describe, it, expect } from 'vitest';
import { emailMatchesIdpDomain } from './idpEmailDomain';

describe('emailMatchesIdpDomain', () => {
  it('accepts an address in the registered domain', () => {
    expect(emailMatchesIdpDomain('user@acme.com', 'acme.com')).toBe(true);
  });

  it('is case-insensitive on both sides', () => {
    expect(emailMatchesIdpDomain('User@ACME.com', 'acme.com')).toBe(true);
    expect(emailMatchesIdpDomain('user@acme.com', 'ACME.COM')).toBe(true);
  });

  it('rejects an address in another registered IdP domain', () => {
    expect(emailMatchesIdpDomain('victim@b.example', 'a.example')).toBe(false);
  });

  it('rejects a subdomain of the registered domain', () => {
    expect(emailMatchesIdpDomain('user@eu.acme.com', 'acme.com')).toBe(false);
  });

  it('rejects a domain that merely ends with the registered one', () => {
    expect(emailMatchesIdpDomain('user@notacme.com', 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain('user@acme.com.evil.test', 'acme.com')).toBe(false);
  });

  it('matches on the last @ so a quoted local-part cannot spoof the domain', () => {
    expect(emailMatchesIdpDomain('"a@acme.com"@evil.test', 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain('"a@evil.test"@acme.com', 'acme.com')).toBe(true);
  });

  it('fails closed on anything it cannot evaluate', () => {
    expect(emailMatchesIdpDomain(null, 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain(undefined, 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain('', 'acme.com')).toBe(false);
    // A bare nameID with no '@' must not be read as a domain.
    expect(emailMatchesIdpDomain('acme.com', 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain('user@', 'acme.com')).toBe(false);
    expect(emailMatchesIdpDomain('user@acme.com', null)).toBe(false);
    expect(emailMatchesIdpDomain('user@acme.com', '')).toBe(false);
    expect(emailMatchesIdpDomain('user@acme.com', undefined)).toBe(false);
  });

  it('tolerates surrounding whitespace on the stored domain', () => {
    expect(emailMatchesIdpDomain('user@acme.com', ' acme.com ')).toBe(true);
  });
});
