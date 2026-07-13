import { describe, it, expect } from 'vitest';
import { registrableDomain } from './registrableDomain';

describe('registrableDomain', () => {
  it('reduces a subdomain to its eTLD+1', () => {
    expect(registrableDomain('mail.acme.com')).toBe('acme.com');
    expect(registrableDomain('a.b.c.acme.io')).toBe('acme.io');
  });

  it('returns the registrable domain unchanged when already eTLD+1', () => {
    expect(registrableDomain('acme.com')).toBe('acme.com');
  });

  it('handles multi-level public suffixes correctly', () => {
    expect(registrableDomain('acme.co.uk')).toBe('acme.co.uk');
    expect(registrableDomain('sub.acme.co.uk')).toBe('acme.co.uk');
  });

  it('lowercases and trims before resolving', () => {
    expect(registrableDomain('  JO.ACME.COM  ')).toBe('acme.com');
  });

  it('returns null for a bare public suffix (no owner)', () => {
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });

  it('returns null for invalid or empty input', () => {
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('not a domain')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain(null)).toBeNull();
    expect(registrableDomain(undefined)).toBeNull();
  });

  it('does not treat a lookalike as the target registrable domain', () => {
    // Guards the gate against evilacme.com / acme.com.evil.io spoofing acme.com.
    expect(registrableDomain('evilacme.com')).not.toBe('acme.com');
    expect(registrableDomain('acme.com.evil.io')).not.toBe('acme.com');
  });
});
