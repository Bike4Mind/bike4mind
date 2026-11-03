import { promises as dns } from 'node:dns';
import { emailDomainCandidates, emailDomainOf, isEmailInDomains } from '@bike4mind/common';
import type { DisposableListSource, DomainIntel, SignupProtectionRepository } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { isDisposableEmail, REJECT_TIER_SOURCES } from './disposableEmail';

const FAILED = Symbol('failed');
const DAY_MS = 24 * 60 * 60 * 1000;
const INTEL_TTL_MS = 7 * DAY_MS;
// Short because a cold start's bootstrap fetch can eat the whole budget; an hour bounds how long a
// domain escapes while still capping retries against a registry that is down or rate limiting.
const FAILED_INTEL_TTL_MS = 60 * 60 * 1000;
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RDAP_BOOTSTRAP_TTL_MS = DAY_MS;
// Fetched outside the per-signup budget so a slow cold start still warms the next lookup.
const RDAP_BOOTSTRAP_TIMEOUT_MS = 10_000;

type MxRecord = { exchange: string; priority: number };
export type DomainLookupOptions = {
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  resolveMx?: (domain: string, timeoutMs: number) => Promise<MxRecord[]>;
  now?: Date;
};

let bootstrap: { loadedAt: number; servers: Promise<Map<string, string>> } | null = null;

/** Test hook: forget the memoised IANA bootstrap. */
export const resetRdapBootstrap = () => {
  bootstrap = null;
};

const loadRdapServers = (fetchImpl: typeof fetch): Promise<Map<string, string>> => {
  if (bootstrap && Date.now() - bootstrap.loadedAt < RDAP_BOOTSTRAP_TTL_MS) return bootstrap.servers;
  const servers = (async () => {
    const response = await fetchImpl(RDAP_BOOTSTRAP_URL, { signal: AbortSignal.timeout(RDAP_BOOTSTRAP_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`RDAP bootstrap HTTP ${response.status}`);
    const body = (await response.json()) as { services?: [string[], string[]][] };
    const map = new Map<string, string>();
    for (const [tlds, urls] of body.services ?? []) {
      const base = urls.find(url => url.startsWith('https://')) ?? urls[0];
      if (base) for (const tld of tlds) map.set(tld.toLowerCase(), base.endsWith('/') ? base : `${base}/`);
    }
    return map;
  })();
  const entry = { loadedAt: Date.now(), servers };
  bootstrap = entry;
  servers.catch(() => {
    if (bootstrap === entry) bootstrap = null;
  });
  return servers;
};

/** Registration date from RDAP; undefined when the registry publishes none. Throws when the lookup fails. */
async function lookupRegisteredAt(domain: string, opts: DomainLookupOptions): Promise<Date | undefined> {
  const rdapDomain = registrableDomain(domain) ?? domain;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const servers = await loadRdapServers(fetchImpl);
  const labels = rdapDomain.split('.');
  // Longest suffix first, so a multi-label entry wins over its TLD.
  const base = labels.map((_, i) => servers.get(labels.slice(i).join('.'))).find(Boolean);
  if (!base) throw new Error('No RDAP server for this TLD');
  const response = await fetchImpl(`${base}domain/${rdapDomain}`, {
    headers: { Accept: 'application/rdap+json' },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!response.ok) throw new Error(`RDAP HTTP ${response.status}`);
  const body = (await response.json()) as { events?: { eventAction?: string; eventDate?: string }[] };
  const date = body.events?.find(event => event.eventAction === 'registration')?.eventDate;
  const registeredAt = date ? new Date(date) : undefined;
  return registeredAt &&
    !Number.isNaN(registeredAt.getTime()) &&
    registeredAt.getTime() <= (opts.now ?? new Date()).getTime() + DAY_MS
    ? registeredAt
    : undefined;
}

const defaultResolveMx = (domain: string, timeoutMs: number) =>
  new dns.Resolver({ timeout: timeoutMs, tries: 1 }).resolveMx(domain);

const isNoMxError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  ['ENODATA', 'ENOTFOUND'].includes(String(error.code));

async function lookupMx(domain: string, opts: DomainLookupOptions): Promise<{ hosts: string[]; flags: string[] }> {
  let records: MxRecord[];
  try {
    records = await (opts.resolveMx ?? defaultResolveMx)(domain, opts.timeoutMs);
  } catch (error) {
    if (isNoMxError(error)) return { hosts: [], flags: ['no-mx'] };
    throw error;
  }
  const hosts = [...new Set(records.map(record => record.exchange.toLowerCase().replace(/\.$/, '')).filter(Boolean))];
  if (hosts.length === 0) return { hosts, flags: ['no-mx'] };
  const flags = new Set<string>();
  for (const host of hosts) {
    if (host.endsWith('.mx.cloudflare.net')) flags.add('cloudflare-routing');
    if (host.endsWith('.google.com') || host.endsWith('.googlemail.com')) flags.add('google-workspace');
    if (registrableDomain(host, { allowPrivateDomains: true }) === domain) flags.add('self-hosted');
  }
  return { hosts, flags: [...flags] };
}

/**
 * RDAP and MX for one registrable domain, in parallel under one shared budget; a lookup that misses
 * the deadline counts as failed without discarding the other. Never throws.
 */
export async function lookupDomainIntel(domain: string, opts: DomainLookupOptions): Promise<DomainIntel> {
  const now = opts.now ?? new Date();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FAILED>(resolve => {
    timer = setTimeout(() => resolve(FAILED), opts.timeoutMs);
  });
  const withinBudget = <T>(lookup: Promise<T>) =>
    Promise.race([lookup.catch(() => FAILED), deadline]) as Promise<T | typeof FAILED>;
  const [rdap, mxResult] = await Promise.all([
    withinBudget(lookupRegisteredAt(domain, opts)),
    withinBudget(lookupMx(domain, opts)),
  ]).finally(() => clearTimeout(timer));
  const failures: DomainIntel['failed'] = [];
  if (rdap === FAILED) failures.push('rdap');
  if (mxResult === FAILED) failures.push('mx');
  const registeredAt = rdap === FAILED ? undefined : rdap;
  const mx = mxResult === FAILED ? { hosts: [], flags: [] } : mxResult;
  return {
    domain,
    ...(registeredAt ? { registeredAt } : {}),
    mxHosts: mx.hosts,
    mxFlags: mx.flags,
    failed: failures,
    checkedAt: now,
    expiresAt: new Date(now.getTime() + (failures.length ? FAILED_INTEL_TTL_MS : INTEL_TTL_MS)),
  };
}

/**
 * Cached intel for a registrable domain: at most one network lookup per domain per TTL (7 days, or
 * 1 hour after a failed lookup). A cache write failure is logged and the fresh result still used.
 */
export async function getDomainIntel(
  domain: string,
  repository: Required<Pick<SignupProtectionRepository, 'findDomainIntel' | 'saveDomainIntel'>>,
  opts: DomainLookupOptions
): Promise<DomainIntel> {
  const cached = await repository.findDomainIntel(domain);
  if (cached) return cached;
  // ponytail: no in-flight dedupe, so concurrent first signups on one domain each look it up.
  const intel = await lookupDomainIntel(domain, opts);
  if (intel.failed.length) console.warn('Domain intelligence lookup failed', { domain, failed: intel.failed });
  try {
    await repository.saveDomainIntel(intel);
  } catch (error) {
    console.warn('Domain intelligence cache write failed', { domain, error: String(error) });
  }
  return intel;
}

const isYoung = (intel: Pick<DomainIntel, 'registeredAt'>, youngerThanDays: number, now: Date) =>
  youngerThanDays > 0 &&
  !!intel.registeredAt &&
  now.getTime() - new Date(intel.registeredAt).getTime() < youngerThanDays * DAY_MS;

const isAggregateOnly = (sources: readonly DisposableListSource[]) =>
  sources.length > 0 && sources.every(source => !REJECT_TIER_SOURCES.has(source));

/**
 * Risk facts for a signup domain, e.g. for a signup risk score: `young-domain`, `single-source-list`
 * (only on the aggregate list), plus the MX flags (`cloudflare-routing`, `google-workspace`,
 * `self-hosted`, `no-mx`).
 */
export function domainRiskFacts(
  intel: Pick<DomainIntel, 'registeredAt' | 'mxFlags'> | null,
  options: { youngerThanDays: number; listSources: readonly DisposableListSource[]; now?: Date }
): string[] {
  const facts: string[] = [];
  if (intel && isYoung(intel, options.youngerThanDays, options.now ?? new Date())) facts.push('young-domain');
  if (isAggregateOnly(options.listSources)) facts.push('single-source-list');
  return [...facts, ...(intel?.mxFlags ?? [])];
}

/**
 * Why a signup's free credits should be held for review, or null. The caller has already exempted
 * mailbox providers and organization domains. Fails open: any error logs and returns null.
 */
export async function domainHoldReason(
  email: string,
  options: {
    repository: SignupProtectionRepository;
    youngerThanDays: number;
    timeoutMs: number;
    adminBlockedDomains: ReadonlySet<string>;
    lookup?: Partial<Omit<DomainLookupOptions, 'timeoutMs'>>;
  }
): Promise<string | null> {
  const { repository } = options;
  const domain = registrableDomain(emailDomainOf(email), { allowPrivateDomains: true });
  try {
    const sources = (await repository.disposableSources?.(emailDomainCandidates(email))) ?? [];
    if (sources.length) return isAggregateOnly(sources) ? 'disposable-aggregate' : 'disposable-list';
    if (isDisposableEmail(email)) return 'disposable-list';
    if (!domain || !repository.findDomainIntel || !repository.saveDomainIntel) return null;

    const intel = await getDomainIntel(
      domain,
      { findDomainIntel: repository.findDomainIntel, saveDomainIntel: repository.saveDomainIntel },
      { ...options.lookup, timeoutMs: options.timeoutMs }
    );
    if (isYoung(intel, options.youngerThanDays, options.lookup?.now ?? new Date()))
      return `young-domain (<${options.youngerThanDays} days)`;
    // Judged at read time, not cached, so a provider listed after the lookup is still caught.
    for (const hostDomain of new Set(
      intel.mxHosts.map(host => registrableDomain(host, { allowPrivateDomains: true }))
    )) {
      if (!hostDomain || hostDomain === domain) continue;
      const rejectTier =
        isDisposableEmail(`x@${hostDomain}`) ||
        isEmailInDomains(`x@${hostDomain}`, options.adminBlockedDomains) ||
        ((await repository.disposableSources?.([hostDomain])) ?? []).some(source => REJECT_TIER_SOURCES.has(source));
      if (rejectTier) return `burner-mx (${hostDomain})`;
    }
    return null;
  } catch (error) {
    console.warn('Domain intelligence check failed; not holding', { domain, error: String(error) });
    return null;
  }
}
