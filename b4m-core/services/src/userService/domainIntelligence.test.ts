import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisposableListSource, DomainIntel, SignupProtectionRepository } from '@bike4mind/common';
import {
  domainAcceptsMail,
  domainHoldReason,
  domainRiskFacts,
  getDomainIntel,
  lookupDomainIntel,
  resetRdapBootstrap,
} from './domainIntelligence';

const NOW = new Date('2026-06-01T00:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const json = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const bootstrap = { services: [[['test'], ['https://rdap.example.test/']]] };

/** fetch stub: IANA bootstrap, then the RDAP domain record (or a status code). */
const rdapFetch = (record: unknown, status = 200) =>
  vi.fn(async (url: string | URL | Request) =>
    String(url).includes('data.iana.org') ? json(bootstrap) : json(record, status)
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

const registered = (days: number) => ({ events: [{ eventAction: 'registration', eventDate: daysAgo(days) }] });

const lookupOptions = (overrides: Record<string, unknown> = {}) => ({
  timeoutMs: 500,
  fetchImpl: rdapFetch(registered(400)),
  resolveMx: vi.fn(async () => [{ exchange: 'mx.example-host.test', priority: 10 }]),
  now: NOW,
  ...overrides,
});

const memoryRepo = (sources: Record<string, DisposableListSource[]> = {}) => {
  const cache = new Map<string, DomainIntel>();
  return {
    observe: vi.fn(),
    recent: vi.fn(),
    findReview: vi.fn(),
    createHold: vi.fn(),
    isOrganizationDomain: vi.fn(),
    disposableSources: vi.fn(async (domains: string[]) => [...new Set(domains.flatMap(d => sources[d] ?? []))]),
    findDomainIntel: vi.fn(async (domain: string) => cache.get(domain) ?? null),
    saveDomainIntel: vi.fn(async (intel: DomainIntel) => {
      cache.set(intel.domain, intel);
    }),
  } satisfies SignupProtectionRepository;
};

beforeEach(() => {
  resetRdapBootstrap();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('lookupDomainIntel', () => {
  it('reads the RDAP registration date and flags commodity MX hosts', async () => {
    const intel = await lookupDomainIntel(
      'fresh-burner.test',
      lookupOptions({
        fetchImpl: rdapFetch(registered(3)),
        resolveMx: async () => [
          { exchange: 'route1.mx.cloudflare.net.', priority: 1 },
          { exchange: 'in.temp-mail-provider.test', priority: 5 },
        ],
      })
    );
    expect(intel.registeredAt?.toISOString()).toBe(daysAgo(3));
    expect(intel.mxFlags).toEqual(['cloudflare-routing']);
    expect(intel.failed).toEqual([]);
    expect(intel.expiresAt.getTime() - NOW.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('treats a 429, a TLD without an RDAP server and a DNS error as failed lookups with a short TTL', async () => {
    const rateLimited = await lookupDomainIntel(
      'busy.test',
      lookupOptions({
        fetchImpl: rdapFetch({}, 429),
        resolveMx: async () => {
          throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
        },
      })
    );
    expect(rateLimited.failed.sort()).toEqual(['mx', 'rdap']);
    expect(rateLimited.expiresAt.getTime() - NOW.getTime()).toBe(60 * 60 * 1000);
    const noServer = await lookupDomainIntel('unlisted.invalidtld', lookupOptions());
    expect(noServer.failed).toEqual(['rdap']);
  });

  it('records no-mx for a domain without MX records', async () => {
    const intel = await lookupDomainIntel(
      'nomail.test',
      lookupOptions({
        resolveMx: async () => {
          throw Object.assign(new Error('no data'), { code: 'ENODATA' });
        },
      })
    );
    expect(intel.mxFlags).toEqual(['no-mx']);
    expect(intel.failed).toEqual([]);

    const unresolved = await lookupDomainIntel(
      'gone.test',
      lookupOptions({
        resolveMx: async () => {
          throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
        },
      })
    );
    expect(unresolved.mxFlags).toEqual(['no-mx']);
    expect(unresolved.failed).toEqual([]);
  });

  it('flags self-hosted and Google Workspace MX hosts', async () => {
    const intel = await lookupDomainIntel(
      'own-mail.test',
      lookupOptions({
        resolveMx: async () => [
          { exchange: 'mail.own-mail.test', priority: 1 },
          { exchange: 'aspmx.l.google.com', priority: 5 },
        ],
      })
    );
    expect(intel.mxFlags.sort()).toEqual(['google-workspace', 'self-hosted']);
  });

  it('fails open when the lookups outlive the budget', async () => {
    const intel = await lookupDomainIntel(
      'slow.test',
      lookupOptions({
        timeoutMs: 20,
        fetchImpl: vi.fn(() => new Promise(() => {})),
        resolveMx: () => new Promise(() => {}),
      })
    );
    expect(intel.failed.sort()).toEqual(['mx', 'rdap']);
    expect(intel.mxFlags).toEqual([]);
  });

  it('keeps a finished lookup when the other misses the budget', async () => {
    const intel = await lookupDomainIntel(
      'half-slow.test',
      lookupOptions({ timeoutMs: 20, fetchImpl: vi.fn(() => new Promise(() => {})) })
    );
    expect(intel.failed).toEqual(['rdap']);
    expect(intel.mxHosts).toEqual(['mx.example-host.test']);
  });
});

describe('getDomainIntel', () => {
  it('looks a domain up once and serves repeats from the cache', async () => {
    const repo = memoryRepo();
    const opts = lookupOptions();
    await getDomainIntel('cached.test', repo, opts);
    await getDomainIntel('cached.test', repo, opts);
    expect(opts.resolveMx).toHaveBeenCalledTimes(1);
    expect(repo.saveDomainIntel).toHaveBeenCalledTimes(1);
  });

  it('caches a failed lookup and still answers when the cache write fails', async () => {
    const repo = memoryRepo();
    repo.saveDomainIntel.mockRejectedValueOnce(new Error('db down'));
    const intel = await getDomainIntel('flaky.test', repo, lookupOptions({ fetchImpl: rdapFetch({}, 503) }));
    expect(intel.failed).toEqual(['rdap']);
    expect(console.warn).toHaveBeenCalledWith('Domain intelligence lookup failed', expect.anything());
  });
});

describe('domainHoldReason', () => {
  const reasonFor = (email: string, repo: SignupProtectionRepository, overrides: Record<string, unknown> = {}) =>
    domainHoldReason(email, {
      repository: repo,
      youngerThanDays: 30,
      timeoutMs: 500,
      adminBlockedDomains: new Set(),
      lookup: lookupOptions(overrides),
    });

  it('holds aggregate-only list domains, including a rotated subdomain, without a network lookup', async () => {
    const repo = memoryRepo({ 'example-burner.test': ['aggregate'] });
    expect(await reasonFor('a@x7.example-burner.test', repo)).toBe('disposable-aggregate');
    expect(repo.findDomainIntel).not.toHaveBeenCalled();
  });

  it('labels a reject-tier domain that reaches the hold step as disposable-list', async () => {
    const repo = memoryRepo({ 'listed.test': ['aggregate', 'curated'] });
    expect(await reasonFor('a@listed.test', repo)).toBe('disposable-list');
    expect(await reasonFor('a@mailinator.com', memoryRepo())).toBe('disposable-list');
  });

  it('holds a domain younger than the threshold and passes one at the boundary', async () => {
    expect(await reasonFor('a@young.test', memoryRepo(), { fetchImpl: rdapFetch(registered(29)) })).toBe(
      'young-domain (<30 days)'
    );
    expect(await reasonFor('a@settled.test', memoryRepo(), { fetchImpl: rdapFetch(registered(30)) })).toBeNull();
  });

  it('never holds on age when the threshold is 0', async () => {
    const reason = await domainHoldReason('a@young.test', {
      repository: memoryRepo(),
      youngerThanDays: 0,
      timeoutMs: 500,
      adminBlockedDomains: new Set(),
      lookup: lookupOptions({ fetchImpl: rdapFetch(registered(1)) }),
    });
    expect(reason).toBeNull();
  });

  it.each([
    ['2027-06-01T00:00:00Z', null],
    ['2026-06-01T01:00:00Z', 'young-domain (<30 days)'],
  ])('checks future registration date %s while allowing small clock skew', async (eventDate, expected) => {
    const reason = await reasonFor('a@future.test', memoryRepo(), {
      fetchImpl: rdapFetch({ events: [{ eventAction: 'registration', eventDate }] }),
    });
    expect(reason).toBe(expected);
  });

  it('looks up the registrable domain of a subdomain address', async () => {
    const repo = memoryRepo();
    await reasonFor('a@np.rotating.test', repo);
    expect(repo.findDomainIntel).toHaveBeenCalledWith('rotating.test');
  });

  it('looks up tenant MX while querying RDAP for the ICANN parent', async () => {
    const repo = memoryRepo();
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('data.iana.org')
        ? json({ services: [[['io'], ['https://rdap.example.test/']]] })
        : json(registered(400))
    );
    const resolveMx = vi.fn(async () => [{ exchange: 'mx.tenant.github.io', priority: 1 }]);
    expect(await reasonFor('a@tenant.github.io', repo, { fetchImpl, resolveMx })).toBeNull();
    expect(resolveMx).toHaveBeenCalledWith('tenant.github.io', 500);
    expect(fetchImpl).toHaveBeenCalledWith('https://rdap.example.test/domain/github.io', expect.anything());
    expect(repo.findDomainIntel).toHaveBeenCalledWith('tenant.github.io');
    expect(repo.saveDomainIntel).toHaveBeenCalledWith(expect.objectContaining({ mxFlags: ['self-hosted'] }));
  });

  it('holds burner MX hosted under a private suffix', async () => {
    const repo = memoryRepo({ 'burner.github.io': ['fakefilter'] });
    expect(
      await reasonFor('a@front.test', repo, {
        resolveMx: async () => [{ exchange: 'mx.burner.github.io', priority: 1 }],
      })
    ).toBe('burner-mx (burner.github.io)');
    expect(repo.disposableSources).toHaveBeenCalledWith(['burner.github.io']);
  });

  it('holds burner MX but never commodity MX alone', async () => {
    const burner = await reasonFor('a@front.test', memoryRepo({ 'temp-mail-provider.test': ['fakefilter'] }), {
      resolveMx: async () => [{ exchange: 'mx.temp-mail-provider.test', priority: 1 }],
    });
    expect(burner).toBe('burner-mx (temp-mail-provider.test)');
    const mixed = await reasonFor('a@mixed.test', memoryRepo({ 'temp-mail-provider.test': ['curated'] }), {
      resolveMx: async () => [
        { exchange: 'route1.mx.cloudflare.net', priority: 1 },
        { exchange: 'in.temp-mail-provider.test', priority: 5 },
      ],
    });
    expect(mixed).toBe('burner-mx (temp-mail-provider.test)');
    const routed = await reasonFor('a@custom.test', memoryRepo(), {
      resolveMx: async () => [{ exchange: 'route1.mx.cloudflare.net', priority: 1 }],
    });
    expect(routed).toBeNull();
  });

  it('judges burner MX at read time, so a provider listed after the lookup is caught from the cache', async () => {
    const sources: Record<string, DisposableListSource[]> = {};
    const repo = memoryRepo(sources);
    const mx = { resolveMx: vi.fn(async () => [{ exchange: 'mx.later-listed.test', priority: 1 }]) };
    expect(await reasonFor('a@front.test', repo, mx)).toBeNull();
    sources['later-listed.test'] = ['fakefilter'];
    expect(await reasonFor('a@front.test', repo, mx)).toBe('burner-mx (later-listed.test)');
    expect(mx.resolveMx).toHaveBeenCalledTimes(1);
  });

  it('fails open when the list read throws', async () => {
    const repo = memoryRepo();
    repo.disposableSources.mockRejectedValue(new Error('db down'));
    expect(await reasonFor('a@any.test', repo)).toBeNull();
  });
});

describe('domainRiskFacts', () => {
  it('reports young-domain, single-source-list and the MX flags', () => {
    expect(
      domainRiskFacts(
        { registeredAt: new Date(daysAgo(2)), mxFlags: ['cloudflare-routing'] },
        { youngerThanDays: 30, listSources: ['aggregate'], now: NOW }
      )
    ).toEqual(['young-domain', 'single-source-list', 'cloudflare-routing']);
    expect(domainRiskFacts(null, { youngerThanDays: 30, listSources: ['aggregate', 'curated'] })).toEqual([]);
  });
});

describe('domainAcceptsMail', () => {
  const dnsError = (code: string) => Object.assign(new Error(code), { code });
  const resolver = (overrides: Partial<Record<'resolveMx' | 'resolve4' | 'resolve6', () => Promise<unknown>>>) =>
    ({
      resolveMx: vi.fn(async () => []),
      resolve4: vi.fn(async () => []),
      resolve6: vi.fn(async () => []),
      ...overrides,
    }) as never;

  it('accepts a domain with an MX host', async () => {
    const mx = resolver({ resolveMx: async () => [{ exchange: 'mx.example.com', priority: 10 }] });
    expect(await domainAcceptsMail('example.com', { timeoutMs: 1000, resolver: mx })).toBe(true);
  });

  it('rejects a null MX', async () => {
    const mx = resolver({ resolveMx: async () => [{ exchange: '', priority: 0 }] });
    expect(await domainAcceptsMail('example.com', { timeoutMs: 1000, resolver: mx })).toBe(false);
  });

  it('rejects a domain that does not exist', async () => {
    const mx = resolver({ resolveMx: async () => Promise.reject(dnsError('ENOTFOUND')) });
    expect(await domainAcceptsMail('nope.example', { timeoutMs: 1000, resolver: mx })).toBe(false);
  });

  it('falls back to address records when there is no MX', async () => {
    const noMx = async () => Promise.reject(dnsError('ENODATA'));
    expect(
      await domainAcceptsMail('example.com', {
        timeoutMs: 1000,
        resolver: resolver({ resolveMx: noMx, resolve6: async () => ['2001:db8::1'] }),
      })
    ).toBe(true);
    expect(
      await domainAcceptsMail('example.com', {
        timeoutMs: 1000,
        resolver: resolver({
          resolveMx: noMx,
          resolve4: async () => Promise.reject(dnsError('ENODATA')),
          resolve6: async () => Promise.reject(dnsError('ENOTFOUND')),
        }),
      })
    ).toBe(false);
  });

  it('is undecided when a lookup fails or misses the deadline', async () => {
    const failing = resolver({ resolveMx: async () => Promise.reject(dnsError('ESERVFAIL')) });
    expect(await domainAcceptsMail('example.com', { timeoutMs: 1000, resolver: failing })).toBeUndefined();

    const partial = resolver({
      resolveMx: async () => Promise.reject(dnsError('ENODATA')),
      resolve4: async () => Promise.reject(dnsError('ETIMEOUT')),
    });
    expect(await domainAcceptsMail('example.com', { timeoutMs: 1000, resolver: partial })).toBeUndefined();

    const hanging = resolver({ resolveMx: () => new Promise(() => {}) });
    expect(await domainAcceptsMail('example.com', { timeoutMs: 20, resolver: hanging })).toBeUndefined();
  });
});
