import { describe, expect, it } from 'vitest';
import { buildLinkHosts, classifyLink, isHttpsUrl, isLinkHostAllowed } from './linkPolicy';

const options = { linkHosts: ['app.example.com', 'Status.Example.com'], supportEmail: 'help@example.com' };

describe('classifyLink', () => {
  it('links https URLs on the allowlist and shows the host', () => {
    expect(classifyLink('https://app.example.com/path?x=1', options)).toEqual({
      allowed: true,
      href: 'https://app.example.com/path?x=1',
      host: 'app.example.com',
    });
    expect(classifyLink('https://STATUS.example.com./', options)).toMatchObject({
      allowed: true,
      host: 'status.example.com',
    });
  });

  it.each([
    ['https://evil.example.net/', 'host_not_allowed'],
    ['https://app.example.com.evil.net/', 'host_not_allowed'],
    ['https://sub.app.example.com/', 'host_not_allowed'],
    ['http://app.example.com/', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['JaVaScRiPt:alert(1)', 'scheme'],
    ['data:text/html,x', 'scheme'],
    ['//app.example.com/', 'scheme'],
    ['https://user:pw@app.example.com/', 'credentials'],
    ['https://app.example.com:8443/', 'port'],
    ['https://app.example.com\\@evil.net/', 'invalid'],
    ['https://app.example.com/a b', 'invalid'],
    ['', 'invalid'],
  ])('renders %s as plain text', (href, reason) => {
    expect(classifyLink(href, options)).toEqual({ allowed: false, reason });
  });

  it('allows mailto only to the configured support address', () => {
    expect(classifyLink('mailto:HELP@example.com', options)).toMatchObject({
      allowed: true,
      href: 'mailto:help@example.com',
    });
    expect(classifyLink('mailto:other@example.com', options)).toEqual({ allowed: false, reason: 'mailto_not_allowed' });
    expect(classifyLink('mailto:help@example.com?subject=x', options)).toEqual({
      allowed: false,
      reason: 'mailto_not_allowed',
    });
    expect(classifyLink('mailto:help@example.com', { linkHosts: [] })).toEqual({
      allowed: false,
      reason: 'mailto_not_allowed',
    });
  });

  it('an empty allowlist links nothing', () => {
    expect(classifyLink('https://app.example.com/', { linkHosts: [] })).toEqual({
      allowed: false,
      reason: 'host_not_allowed',
    });
  });
});

describe('link helpers', () => {
  it('builds a sorted, de-duplicated host list from https URLs only', () => {
    expect(
      buildLinkHosts([
        'https://b.example.com/x',
        'https://A.example.com',
        'https://b.example.com/y',
        'http://c.example.com',
        'nope',
        null,
      ])
    ).toEqual(['a.example.com', 'b.example.com']);
  });

  it('matches hosts case-insensitively and exactly', () => {
    expect(isLinkHostAllowed('APP.example.com', ['app.example.com'])).toBe(true);
    expect(isLinkHostAllowed('example.com', ['app.example.com'])).toBe(false);
    expect(isLinkHostAllowed('', [''])).toBe(false);
  });

  it('isHttpsUrl requires the https scheme', () => {
    expect(isHttpsUrl('https://example.com')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('example.com')).toBe(false);
  });
});
