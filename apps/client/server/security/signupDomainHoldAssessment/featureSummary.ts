/**
 * Builds the only thing the signup domain hold assessment sends to a provider: a strict summary of
 * counts and flags for one held domain. Every field is derived in code and the result is parsed with
 * a strict schema, so emails, IPs, the domain name and anything the domain's site serves can never
 * ride along. The site body is read here only to derive `hasContent`; it is never returned.
 */

import { isIPv4, isIPv6 } from 'node:net';
import { z } from 'zod';
import type { DomainIntel, ISignupMeta } from '@bike4mind/common';
import { isResponseTooLargeError, safeFetch } from '@bike4mind/server-utils/utils/ssrfProtection';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SITE_TIMEOUT_MS = 4000;
const SITE_MAX_BODY_BYTES = 256 * 1024;
// Visible text below this reads as a parked, placeholder or empty page.
const MIN_VISIBLE_TEXT_CHARS = 200;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;

export const MX_PROVIDER_CLASSES = [
  'google_workspace',
  'microsoft',
  'cloudflare_routing',
  'self_hosted',
  'other',
  'none',
  'unknown',
] as const;
export type MxProviderClass = (typeof MX_PROVIDER_CLASSES)[number];

const count = z.number().int().min(0);

export const signupDomainHoldFeatureSummarySchema = z.strictObject({
  /** Days since registration (RDAP); null when the registry did not answer. */
  domainAgeDays: count.nullable(),
  mxProvider: z.enum(MX_PROVIDER_CLASSES),
  site: z.strictObject({ resolves: z.boolean(), hasContent: z.boolean() }),
  signups: z.strictObject({
    count,
    /** Held accounts the timing and network figures are taken from. */
    accountsSummarized: count,
    spanMinutes: count.nullable(),
    medianGapMinutes: count.nullable(),
  }),
  network: z.strictObject({
    accountsWithNetworkData: count,
    /** Distinct /24 (IPv4) or /48 (IPv6) prefixes. */
    distinctIpPrefixes: count,
    distinctAsns: count,
    distinctCountries: count,
    /** Share (0-1) of accounts with a known network type that signed up from a datacenter. */
    datacenterShare: z.number().min(0).max(1).nullable(),
  }),
});
export type SignupDomainHoldFeatureSummary = z.infer<typeof signupDomainHoldFeatureSummarySchema>;

export type SiteProbe = SignupDomainHoldFeatureSummary['site'];
export type CohortAccount = {
  createdAt: Date | null;
  signupMeta: Pick<ISignupMeta, 'ip' | 'asn' | 'country' | 'isDatacenter'> | null;
};

const MICROSOFT_MX_SUFFIXES = ['.mail.protection.outlook.com', '.outlook.com'];

/** A small provider class from the cached MX facts; `unknown` when the lookup itself failed. */
export function mxProviderClass(intel: Pick<DomainIntel, 'mxHosts' | 'mxFlags' | 'failed'> | null): MxProviderClass {
  if (!intel || intel.failed.includes('mx')) return 'unknown';
  const flags = new Set(intel.mxFlags);
  if (flags.has('no-mx') || intel.mxHosts.length === 0) return 'none';
  if (flags.has('google-workspace')) return 'google_workspace';
  if (intel.mxHosts.some(host => MICROSOFT_MX_SUFFIXES.some(suffix => host.toLowerCase().endsWith(suffix))))
    return 'microsoft';
  if (flags.has('cloudflare-routing')) return 'cloudflare_routing';
  if (flags.has('self-hosted')) return 'self_hosted';
  return 'other';
}

export function domainAgeDays(intel: Pick<DomainIntel, 'registeredAt'> | null, now: Date): number | null {
  if (!intel?.registeredAt) return null;
  const registeredAt = new Date(intel.registeredAt).getTime();
  if (!Number.isFinite(registeredAt)) return null;
  return Math.max(0, Math.floor((now.getTime() - registeredAt) / DAY_MS));
}

const visibleText = (html: string) =>
  html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Whether `https://<domain>/` answers, and whether it answers 2xx with a page of real text. Never
 * throws: any fetch error (DNS, TLS, timeout, SSRF guard) reads as not resolving.
 */
export async function probeSite(domain: string, fetchImpl: typeof safeFetch = safeFetch): Promise<SiteProbe> {
  if (!HOSTNAME.test(domain)) return { resolves: false, hasContent: false };
  let response: Response;
  try {
    response = await fetchImpl(
      `https://${domain}/`,
      { method: 'GET', headers: { accept: 'text/html' }, signal: AbortSignal.timeout(SITE_TIMEOUT_MS) },
      { maxBodyBytes: SITE_MAX_BODY_BYTES }
    );
  } catch (error) {
    // A body over the cap is still a site with content.
    if (isResponseTooLargeError(error)) return { resolves: true, hasContent: true };
    return { resolves: false, hasContent: false };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { resolves: true, hasContent: false };
  }
  try {
    return { resolves: true, hasContent: visibleText(await response.text()).length >= MIN_VISIBLE_TEXT_CHARS };
  } catch (error) {
    return { resolves: true, hasContent: isResponseTooLargeError(error) };
  }
}

const expandIPv6 = (ip: string): string[] => {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map(group => group.toLowerCase().replace(/^0+(?=.)/, ''));
};

/** The /24 (IPv4) or /48 (IPv6) network an address belongs to; null for anything else. */
export function ipPrefix(ip: string | null): string | null {
  if (!ip) return null;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const address = mapped ? mapped[1] : ip;
  if (isIPv4(address)) return `${address.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIPv6(address)) return `${expandIPv6(address).slice(0, 3).join(':')}::/48`;
  return null;
}

const minutes = (ms: number) => Math.round(ms / MINUTE_MS);

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function signupTiming(accounts: readonly CohortAccount[]) {
  const times = accounts
    .map(account => account.createdAt?.getTime())
    .filter((time): time is number => typeof time === 'number' && Number.isFinite(time))
    .sort((a, b) => a - b);
  if (times.length < 2) return { spanMinutes: null, medianGapMinutes: null };
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  return { spanMinutes: minutes(times[times.length - 1] - times[0]), medianGapMinutes: minutes(median(gaps)) };
}

function networkSpread(accounts: readonly CohortAccount[]) {
  const metas = accounts.flatMap(account => (account.signupMeta ? [account.signupMeta] : []));
  const distinct = <T>(values: (T | null | undefined)[]) =>
    new Set(values.filter((value): value is T => value !== null && value !== undefined)).size;
  const typed = metas.filter(meta => typeof meta.isDatacenter === 'boolean');
  return {
    accountsWithNetworkData: metas.length,
    distinctIpPrefixes: distinct(metas.map(meta => ipPrefix(meta.ip))),
    distinctAsns: distinct(metas.map(meta => meta.asn)),
    distinctCountries: distinct(metas.map(meta => meta.country)),
    datacenterShare: typed.length
      ? Math.round((typed.filter(meta => meta.isDatacenter).length / typed.length) * 100) / 100
      : null,
  };
}

export function buildSignupDomainHoldFeatureSummary(input: {
  signupCount: number;
  intel: Pick<DomainIntel, 'registeredAt' | 'mxHosts' | 'mxFlags' | 'failed'> | null;
  site: SiteProbe;
  accounts: readonly CohortAccount[];
  now: Date;
}): SignupDomainHoldFeatureSummary {
  return signupDomainHoldFeatureSummarySchema.parse({
    domainAgeDays: domainAgeDays(input.intel, input.now),
    mxProvider: mxProviderClass(input.intel),
    site: { resolves: input.site.resolves, hasContent: input.site.hasContent },
    signups: {
      count: Math.max(0, Math.trunc(input.signupCount)),
      accountsSummarized: input.accounts.length,
      ...signupTiming(input.accounts),
    },
    network: networkSpread(input.accounts),
  });
}
