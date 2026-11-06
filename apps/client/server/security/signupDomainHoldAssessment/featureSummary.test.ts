import { describe, expect, it, vi } from 'vitest';
import {
  buildSignupDomainHoldFeatureSummary,
  domainAgeDays,
  ipPrefix,
  mxProviderClass,
  probeSite,
} from './featureSummary';

const intel = (mxHosts: string[], mxFlags: string[], failed: ('rdap' | 'mx')[] = []) => ({ mxHosts, mxFlags, failed });

describe('mxProviderClass', () => {
  it.each([
    [intel(['aspmx.l.google.com'], ['google-workspace']), 'google_workspace'],
    [intel(['acme-test.mail.protection.outlook.com'], []), 'microsoft'],
    [intel(['route1.mx.cloudflare.net'], ['cloudflare-routing']), 'cloudflare_routing'],
    [intel(['mail.acme.test'], ['self-hosted']), 'self_hosted'],
    [intel(['mx.somehost.example'], []), 'other'],
    [intel([], ['no-mx']), 'none'],
    [intel([], [], ['mx']), 'unknown'],
    [null, 'unknown'],
  ] as const)('maps %j to %s', (input, expected) => {
    expect(mxProviderClass(input)).toBe(expected);
  });
});

describe('domainAgeDays', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  it('counts whole days since registration, null without an RDAP answer', () => {
    expect(domainAgeDays({ registeredAt: new Date('2026-10-20T06:00:00Z') }, now)).toBe(11);
    expect(domainAgeDays({}, now)).toBeNull();
    expect(domainAgeDays(null, now)).toBeNull();
  });
});

describe('ipPrefix', () => {
  it.each([
    ['198.51.100.23', '198.51.100.0/24'],
    ['::ffff:198.51.100.23', '198.51.100.0/24'],
    ['2001:db8:abcd:12::1', '2001:db8:abcd::/48'],
    ['2001:0db8::1', '2001:db8:0::/48'],
    ['not-an-ip', null],
    [null, null],
  ])('%s -> %s', (ip, expected) => {
    expect(ipPrefix(ip)).toBe(expected);
  });
});

const page = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const realText = `<html><body><h1>Acme</h1><p>${'We build tools for teams. '.repeat(20)}</p></body></html>`;

describe('probeSite', () => {
  it('fetches https://<domain>/ with a timeout and a small byte cap', async () => {
    const fetchImpl = vi.fn(async () => page(realText));
    expect(await probeSite('acme.test', fetchImpl)).toEqual({ resolves: true, hasContent: true });
    const [url, init, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit, { maxBodyBytes: number }];
    expect(url).toBe('https://acme.test/');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(options.maxBodyBytes).toBeLessThanOrEqual(256 * 1024);
  });

  it('reads a parked or script-only page as having no content', async () => {
    const parked =
      '<html><head><script>var x = "lots of script text here ".repeat(100)</script></head><body>Parked</body></html>';
    expect(
      await probeSite(
        'acme.test',
        vi.fn(async () => page(parked))
      )
    ).toEqual({ resolves: true, hasContent: false });
  });

  it('reads a non-2xx answer as resolving without content', async () => {
    expect(
      await probeSite(
        'acme.test',
        vi.fn(async () => page(realText, 404))
      )
    ).toEqual({
      resolves: true,
      hasContent: false,
    });
  });

  it('reads a fetch error as not resolving', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await probeSite('acme.test', fetchImpl)).toEqual({ resolves: false, hasContent: false });
  });

  it('never fetches something that is not a hostname', async () => {
    const fetchImpl = vi.fn(async () => page(realText));
    for (const domain of ['acme.test/../x', 'user@acme.test', '127.0.0.1', 'localhost', 'acme.test:8080']) {
      expect(await probeSite(domain, fetchImpl)).toEqual({ resolves: false, hasContent: false });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('buildSignupDomainHoldFeatureSummary', () => {
  it('aggregates timing and networks without carrying identity', () => {
    const summary = buildSignupDomainHoldFeatureSummary({
      signupCount: 5,
      intel: { registeredAt: new Date('2026-10-30T00:00:00Z'), ...intel(['aspmx.l.google.com'], ['google-workspace']) },
      site: { resolves: false, hasContent: false },
      accounts: [
        {
          createdAt: new Date('2026-11-01T00:00:00Z'),
          signupMeta: { ip: '198.51.100.1', asn: 1, country: 'AA', isDatacenter: true },
        },
        {
          createdAt: new Date('2026-11-01T00:02:00Z'),
          signupMeta: { ip: '198.51.100.2', asn: 1, country: 'AA', isDatacenter: false },
        },
        {
          createdAt: new Date('2026-11-01T00:12:00Z'),
          signupMeta: { ip: '192.0.2.9', asn: 2, country: 'BB', isDatacenter: null },
        },
        { createdAt: null, signupMeta: null },
      ],
      now: new Date('2026-11-01T01:00:00Z'),
    });
    expect(summary).toEqual({
      domainAgeDays: 2,
      mxProvider: 'google_workspace',
      site: { resolves: false, hasContent: false },
      signups: { count: 5, accountsSummarized: 4, spanMinutes: 12, medianGapMinutes: 6 },
      network: {
        accountsWithNetworkData: 3,
        distinctIpPrefixes: 2,
        distinctAsns: 2,
        distinctCountries: 2,
        datacenterShare: 0.5,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/198\.51|192\.0|AA|BB/);
  });

  it('leaves timing and the datacenter share null when there is nothing to measure', () => {
    const summary = buildSignupDomainHoldFeatureSummary({
      signupCount: 1,
      intel: null,
      site: { resolves: true, hasContent: true },
      accounts: [],
      now: new Date(),
    });
    expect(summary.signups).toEqual({ count: 1, accountsSummarized: 0, spanMinutes: null, medianGapMinutes: null });
    expect(summary.network.datacenterShare).toBeNull();
    expect(summary.mxProvider).toBe('unknown');
  });
});
