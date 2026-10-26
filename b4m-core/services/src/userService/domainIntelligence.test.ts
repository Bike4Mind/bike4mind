import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisposableListSource, DomainIntel, SignupProtectionRepository } from '@bike4mind/common';
import {
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
  isRejectTier: async (domain: string) => domain === 'temp-mail-provider.test',
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
  it('reads the RDAP registration date and flags commodity and burner MX hosts', async () => {
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
    expect(intel.mxFlags).toEqual(expect.arrayContaining(['cloudflare-routing', 'burner-mx']));
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
  });

  it('fails open when the lookups outlive the budget', async () => {
    const intel = await lookupDomainIntel(
      'slow.test',
      lookupOptions({ timeoutMs: 20, resolveMx: () => new Promise(() => {}) })
    );
    expect(intel.failed.sort()).toEqual(['mx', 'rdap']);
    expect(intel.mxFlags).toEqual([]);
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
  });

  it('holds a domain younger than the threshold and passes one at the boundary', async () => {
    expect(await reasonFor('a@young.test', memoryRepo(), { fetchImpl: rdapFetch(registered(29)) })).toBe(
      'young-domain (<30 days)'
    );
    expect(await reasonFor('a@settled.test', memoryRepo(), { fetchImpl: rdapFetch(registered(30)) })).toBeNull();
  });

  it('looks up the registrable domain of a subdomain address', async () => {
    const repo = memoryRepo();
    await reasonFor('a@np.rotating.test', repo);
    expect(repo.findDomainIntel).toHaveBeenCalledWith('rotating.test');
  });

  it('holds burner MX but never commodity MX alone', async () => {
    const burner = await reasonFor('a@front.test', memoryRepo({ 'temp-mail-provider.test': ['fakefilter'] }), {
      resolveMx: async () => [{ exchange: 'mx.temp-mail-provider.test', priority: 1 }],
    });
    expect(burner).toBe('burner-mx (temp-mail-provider.test)');
    const routed = await reasonFor('a@custom.test', memoryRepo(), {
      resolveMx: async () => [{ exchange: 'route1.mx.cloudflare.net', priority: 1 }],
    });
    expect(routed).toBeNull();
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
