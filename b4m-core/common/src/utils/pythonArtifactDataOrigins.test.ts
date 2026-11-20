import { describe, expect, it } from 'vitest';
import {
  PYTHON_ARTIFACT_DATA_ORIGINS_MAX,
  parsePythonDataOrigin,
  partitionPythonDataOrigins,
  pythonDataOriginReservedHosts,
  resolvePythonArtifactDataOrigins,
  withPythonDataOrigins,
} from './pythonArtifactDataOrigins';

const RESERVED = ['app.example.com', 'example.com'];

describe('parsePythonDataOrigin', () => {
  it.each([
    ['https://data.example.org', 'https://data.example.org'],
    ['https://data.example.org/', 'https://data.example.org'],
    ['  HTTPS://Data.Example.ORG  ', 'https://data.example.org'],
    ['https://data.example.org:8443', 'https://data.example.org:8443'],
    ['https://data.example.org:443', 'https://data.example.org'],
    ['https://xn--bcher-kva.example.org', 'https://xn--bcher-kva.example.org'],
  ])('accepts %j as %s', (raw, origin) => {
    expect(parsePythonDataOrigin(raw)).toEqual({ origin });
  });

  it.each([
    ['not text', 42],
    ['empty', '   '],
    ['http', 'http://data.example.org'],
    ['another scheme', 'ftp://data.example.org'],
    ['no scheme', 'data.example.org'],
    ['a path', 'https://data.example.org/v1'],
    ['a query', 'https://data.example.org?x=1'],
    ['a query after a slash', 'https://data.example.org/?x=1'],
    ['a fragment', 'https://data.example.org#top'],
    ['user info', 'https://user:pass@data.example.org'],
    ['a bare user', 'https://user@data.example.org'],
    ['a wildcard host', 'https://*.example.org'],
    ['a bare wildcard', '*'],
    ['an IPv4 literal', 'https://93.184.216.34'],
    ['an IPv4 literal with a port', 'https://10.0.0.1:8443'],
    ['a numeric IPv4 spelling', 'https://2130706433'],
    ['a wildcard-DNS IPv4 name', 'https://127.0.0.1.nip.io'],
    ['a dashed wildcard-DNS IPv4 name', 'https://10-0-0-1.sslip.io'],
    ['port 0', 'https://data.example.org:0'],
    ['an over-long hostname', `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.org`],
    ['a hex IPv4 spelling', 'https://0x7f.1'],
    ['an IPv6 literal', 'https://[::1]'],
    ['an IPv6 link-local literal', 'https://[fe80::1]'],
    ['localhost', 'https://localhost'],
    ['a localhost subdomain', 'https://api.localhost'],
    ['an mDNS name', 'https://printer.local'],
    ['an internal name', 'https://metadata.google.internal'],
    ['a home.arpa name', 'https://nas.home.arpa'],
    ['a reverse-DNS name', 'https://1.0.0.127.in-addr.arpa'],
    ['a single-label host', 'https://intranet'],
    ['a trailing-dot host', 'https://data.example.org.'],
    ['a CSP separator', 'https://data.example.org;connect-src'],
    ['a second source', 'https://data.example.org https://other.example.org'],
    ['a comma', 'https://data.example.org,other.example.org'],
    ['a quote', "https://data.example.org'"],
    ['a backslash', 'https:\\\\data.example.org'],
  ])('refuses %s', (_label, raw) => {
    const parsed = parsePythonDataOrigin(raw);
    expect(parsed.origin).toBeUndefined();
    expect(parsed.problem).toEqual(expect.any(String));
  });

  it.each([
    ['the app host', 'https://app.example.com'],
    ['the app host on another port', 'https://app.example.com:8443'],
    ['a sibling on the app site', 'https://api.example.com'],
    ['the app site apex', 'https://example.com'],
    ['a deeper subdomain of the app', 'https://x.app.example.com'],
  ])("refuses %s as one of the app's own hosts", (_label, raw) => {
    expect(parsePythonDataOrigin(raw, RESERVED)).toEqual({ problem: "this app's own hosts are not allowed" });
  });

  it('does not treat a host that merely ends with the same letters as reserved', () => {
    expect(parsePythonDataOrigin('https://notexample.com', RESERVED)).toEqual({ origin: 'https://notexample.com' });
  });
});

describe('partitionPythonDataOrigins', () => {
  it('deduplicates canonical origins in entry order and reports each refused entry', () => {
    expect(
      partitionPythonDataOrigins([
        'https://b.example.org',
        'https://A.example.org/',
        'https://b.example.org:443',
        'http://c.example.org',
      ])
    ).toEqual({
      valid: ['https://b.example.org', 'https://a.example.org'],
      invalid: [{ entry: 'http://c.example.org', problem: 'must start with https://' }],
    });
  });

  it('yields nothing for non-array input', () => {
    expect(partitionPythonDataOrigins('https://a.example.org')).toEqual({ valid: [], invalid: [] });
  });
});

describe('resolvePythonArtifactDataOrigins', () => {
  it('returns the canonical list for a valid stored value', () => {
    expect(resolvePythonArtifactDataOrigins(['https://Data.example.org'])).toEqual(['https://data.example.org']);
  });

  it('applies nothing when the setting is unset or not a list', () => {
    expect(resolvePythonArtifactDataOrigins(undefined)).toEqual([]);
    expect(resolvePythonArtifactDataOrigins(null)).toEqual([]);
    expect(resolvePythonArtifactDataOrigins('https://data.example.org')).toEqual([]);
    expect(resolvePythonArtifactDataOrigins({ 0: 'https://data.example.org' })).toEqual([]);
  });

  it('applies nothing when any one entry is invalid', () => {
    expect(resolvePythonArtifactDataOrigins(['https://data.example.org', 'https://10.0.0.1'])).toEqual([]);
  });

  it("applies nothing when an entry names the app's own site", () => {
    expect(resolvePythonArtifactDataOrigins(['https://data.example.org', 'https://api.example.com'], RESERVED)).toEqual(
      []
    );
  });

  it('applies nothing past the cap', () => {
    const atCap = Array.from({ length: PYTHON_ARTIFACT_DATA_ORIGINS_MAX }, (_, i) => `https://d${i}.example.org`);
    expect(resolvePythonArtifactDataOrigins(atCap)).toHaveLength(PYTHON_ARTIFACT_DATA_ORIGINS_MAX);
    expect(resolvePythonArtifactDataOrigins([...atCap, 'https://one-more.example.org'])).toEqual([]);
  });

  it('counts the cap after deduplication', () => {
    const repeated = Array.from({ length: PYTHON_ARTIFACT_DATA_ORIGINS_MAX + 5 }, () => 'https://data.example.org');
    expect(resolvePythonArtifactDataOrigins(repeated)).toEqual(['https://data.example.org']);
  });
});

describe('pythonDataOriginReservedHosts', () => {
  it('reserves the app host and, given a site function, its registrable domain', () => {
    const siteOf = (host: string) => host.split('.').slice(-2).join('.');
    expect(pythonDataOriginReservedHosts(['https://App.Example.com/path'], siteOf)).toEqual([
      'app.example.com',
      'example.com',
    ]);
  });

  it('skips unset and unparseable app URLs', () => {
    expect(pythonDataOriginReservedHosts([undefined, '', 'not a url', 'https://app.example.com'])).toEqual([
      'app.example.com',
    ]);
  });
});

describe('withPythonDataOrigins', () => {
  const PROMPT = 'PYTHON ARTIFACTS: no network.';

  it('returns the prompt byte for byte when no origin is listed', () => {
    expect(withPythonDataOrigins(PROMPT, [])).toBe(PROMPT);
  });

  it('appends one note naming every origin and how to fetch from it', () => {
    const out = withPythonDataOrigins(PROMPT, ['https://data.example.org', 'https://stats.example.net']);
    expect(out.startsWith(`${PROMPT}\n\nPYTHON DATA ORIGINS: `)).toBe(true);
    expect(out).toContain('https://data.example.org, https://stats.example.net');
    expect(out).toContain('pyfetch');
    expect(out).toContain('open_url');
    expect(out).toContain('Every other address is blocked');
    expect(out.split('\n\n')).toHaveLength(2);
  });
});
