import { describe, expect, it } from 'vitest';
import { leastTrusted, parseServerAddress, scopeOfIp, suggestServerName, transportVerdict } from './addressPolicy';

describe('scopeOfIp', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.0.0.3', 'loopback'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.20', 'private'],
    ['::ffff:192.168.1.20', 'private'],
    ['fd00::5', 'private'],
    ['fc12::1', 'private'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'tailscale'],
    ['[fd7a:115c:a1e0::2]', 'tailscale'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['2001:db8::1', 'public'],
    ['::ffff:8.8.8.8', 'public'],
  ])('%s is %s', (ip, scope) => {
    expect(scopeOfIp(ip)).toBe(scope);
  });

  it('counts 100.64.0.0/10 as private, not Tailscale, since carrier-grade NAT shares it', () => {
    expect(scopeOfIp('100.64.0.1')).toBe('private');
    expect(scopeOfIp('100.100.100.100')).toBe('private');
    expect(scopeOfIp('100.127.255.255')).toBe('private');
    expect(scopeOfIp('100.128.0.1')).toBe('public');
    expect(scopeOfIp('100.63.255.255')).toBe('public');
  });

  it('returns null for names', () => {
    expect(scopeOfIp('example.com')).toBeNull();
    expect(scopeOfIp('localhost')).toBeNull();
  });
});

describe('leastTrusted', () => {
  it('takes the least trusted of several resolved addresses', () => {
    expect(leastTrusted(['loopback', 'public'])).toBe('public');
    expect(leastTrusted(['tailscale', 'private'])).toBe('private');
    expect(leastTrusted(['loopback'])).toBe('loopback');
  });
});

describe('transportVerdict', () => {
  it('always allows https, which checks the certificate as usual', () => {
    for (const scope of ['loopback', 'tailscale', 'private', 'public'] as const) {
      expect(transportVerdict('https:', scope, true)).toEqual({ ok: true, unencrypted: false });
    }
  });

  it('sends credentials over http only to loopback and Tailscale IPv6', () => {
    expect(transportVerdict('http:', 'loopback', true).ok).toBe(true);
    expect(transportVerdict('http:', 'tailscale', true).ok).toBe(true);
    expect(transportVerdict('http:', 'private', true).ok).toBe(false);
    expect(transportVerdict('http:', 'public', true).ok).toBe(false);
  });

  it('allows plain http without credentials inside private ranges, marked unencrypted', () => {
    expect(transportVerdict('http:', 'private', false)).toEqual({ ok: true, unencrypted: true });
  });

  it('refuses plain http to a public address even without credentials', () => {
    const verdict = transportVerdict('http:', 'public', false);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/https/);
  });

  it('refuses other schemes', () => {
    expect(transportVerdict('ftp:', 'loopback', false).ok).toBe(false);
  });
});

describe('parseServerAddress', () => {
  it('reads the address forms the issue lists', () => {
    expect(parseServerAddress('https://models.example.test')).toMatchObject({
      protocol: 'https:',
      host: 'models.example.test',
      origin: 'https://models.example.test',
    });
    expect(parseServerAddress('http://192.168.1.5:11434')).toMatchObject({
      protocol: 'http:',
      host: '192.168.1.5',
      origin: 'http://192.168.1.5:11434',
    });
    expect(parseServerAddress('gpu-box:11434')).toMatchObject({ protocol: 'http:', origin: 'http://gpu-box:11434' });
    expect(parseServerAddress('http://[fd7a:115c:a1e0::1]:11434')?.host).toBe('fd7a:115c:a1e0::1');
  });

  it('rejects embedded credentials, queries, and junk', () => {
    expect(parseServerAddress('https://user:pass@models.example.test')).toBeNull();
    expect(parseServerAddress('https://models.example.test/?key=1')).toBeNull();
    expect(parseServerAddress('not an address')).toBeNull();
  });

  it('suggests the first label of a name, or the IP itself', () => {
    expect(suggestServerName(parseServerAddress('https://gpu.home.example.test')!)).toBe('gpu');
    expect(suggestServerName(parseServerAddress('http://10.0.0.4:11434')!)).toBe('10.0.0.4');
  });
});
