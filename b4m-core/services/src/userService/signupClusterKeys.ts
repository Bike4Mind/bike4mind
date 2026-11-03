import { domainToASCII } from 'node:url';
import { emailDomainOf } from '@bike4mind/common';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

/** What DNS/RDAP know about a registrable domain. Every field is optional: a missing fact yields fewer keys. */
export type DomainFacts = {
  mxHosts?: readonly string[];
  nameservers?: readonly string[];
  registrar?: string | null;
  registeredAt?: Date | null;
};

/** Supplied by a live DNS/RDAP adapter or a precomputed file; null when nothing is known. */
export type DomainFactsLookup = (domain: string) => Promise<DomainFacts | null>;

/** The signup data already stored on a user (email, createdAt, signupMeta). */
export type SignupFootprint = {
  userId: string;
  email: string;
  createdAt?: Date | null;
  asn?: number | null;
  isDatacenter?: boolean | null;
};

/** A footprint reduced to what grouping needs, so callers can drop the email address early. */
export type SignupRecord = {
  userId: string;
  domain: string | null;
  localPartShape: string | null;
  createdAt: Date | null;
  asn: number | null;
  isDatacenter: boolean | null;
};

export type ClusterKeyKind = 'mx' | 'ns' | 'registration' | 'localPartShape' | 'asn' | 'signupWindow';

export type ClusterKey = { kind: ClusterKeyKind; value: string; label: string };

/** Every value here is a caller decision; the defaults are neutral placeholders. */
export type ClusterKeyOptions = {
  registrationBucketDays: number;
  signupBucketHours: number;
  /** Local-part shapes that produce a key, or 'any' for every shape. Empty means no shape key. */
  localPartShapes: readonly string[] | 'any';
  minHexLength: number;
  /** MX/NS hosts of shared providers (matched as host suffixes) that never form a key. */
  ignoredInfrastructureHosts: readonly string[];
};

export const DEFAULT_CLUSTER_KEY_OPTIONS: ClusterKeyOptions = {
  registrationBucketDays: 14,
  signupBucketHours: 24,
  localPartShapes: [],
  minHexLength: 6,
  ignoredInfrastructureHosts: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function assertPositiveWidth(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got ${value}`);
  }
}

/**
 * The eTLD+1 of a host or bare domain: trimmed, lowercased, trailing dots stripped and converted to
 * punycode, so `Mail.Example.com.` and `example.com` agree, as do a Unicode domain and its `xn--` form.
 * Null when it is not a valid registrable domain.
 */
export function normalizeRegistrableDomain(domain: string | null): string | null {
  const host = domain?.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return null;
  const ascii = domainToASCII(host);
  if (!ascii) return null;
  return registrableDomain(ascii, { allowPrivateDomains: true });
}

/** The eTLD+1 a signup email belongs to, so `x@mail.example.com` and `y@example.com` group together. */
export const signupRegistrableDomain = (email: string): string | null =>
  normalizeRegistrableDomain(emailDomainOf(email));

const isHexRun = (run: string, minLength: number) =>
  run.length >= minLength && (run.match(/[a-f]/g)?.length ?? 0) >= 2 && (run.match(/[0-9]/g)?.length ?? 0) >= 2;

/**
 * The local part reduced to shape tokens (alpha, digits, hex, sep, other) joined with `+`, ignoring
 * any `+tag`: `jane.doe` -> `alpha+sep+alpha`, `user2024` -> `alpha+digits`.
 * A hex run starts with a digit, has 2+ a-f letters and 2+ digits, and is not followed by another
 * letter; a digit run followed by a word that starts with a-f letters can still read as hex.
 */
export function localPartShape(email: string, minHexLength = DEFAULT_CLUSTER_KEY_OPTIONS.minHexLength): string | null {
  const at = email.lastIndexOf('@');
  const local = at > 0 ? email.slice(0, at).toLowerCase().split('+')[0] : '';
  if (!local) return null;
  const tokens: string[] = [];
  let rest = local;
  while (rest) {
    let token: string;
    let length: number;
    const hexRun = /^[0-9][0-9a-f]*/.exec(rest)?.[0];
    if (hexRun && isHexRun(hexRun, minHexLength) && !/^[g-z]/.test(rest.slice(hexRun.length))) {
      [token, length] = ['hex', hexRun.length];
    } else if (hexRun) {
      [token, length] = ['digits', /^[0-9]+/.exec(rest)![0].length];
    } else if (/^[a-z]/.test(rest)) {
      [token, length] = ['alpha', /^[a-z]+/.exec(rest)![0].length];
    } else if (/^[._-]/.test(rest)) {
      [token, length] = ['sep', /^[._-]+/.exec(rest)![0].length];
    } else {
      [token, length] = ['other', 1];
    }
    if (tokens[tokens.length - 1] !== token) tokens.push(token);
    rest = rest.slice(length);
  }
  return tokens.join('+');
}

export function toSignupRecord(
  signup: SignupFootprint,
  options: ClusterKeyOptions = DEFAULT_CLUSTER_KEY_OPTIONS
): SignupRecord {
  return {
    userId: signup.userId,
    domain: signupRegistrableDomain(signup.email),
    localPartShape: localPartShape(signup.email, options.minHexLength),
    createdAt: signup.createdAt ?? null,
    asn: signup.asn ?? null,
    isDatacenter: signup.isDatacenter ?? null,
  };
}

const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.+$/, '');

const hostSet = (hosts: readonly string[] | undefined, ignored: readonly string[]): string => {
  const ignoredHosts = ignored.map(normalizeHost).filter(Boolean);
  return [...new Set((hosts ?? []).map(normalizeHost).filter(Boolean))]
    .filter(host => !ignoredHosts.some(entry => host === entry || host.endsWith(`.${entry}`)))
    .sort()
    .join(',');
};

// Two grids offset by half a bucket: times less than half a bucket apart share a bucket on at least one.
const timeBuckets = (time: number, bucketMs: number): { id: string; start: string }[] => [
  { id: `a${Math.floor(time / bucketMs)}`, start: new Date(Math.floor(time / bucketMs) * bucketMs).toISOString() },
  {
    id: `b${Math.floor(time / bucketMs + 0.5)}`,
    start: new Date((Math.floor(time / bucketMs + 0.5) - 0.5) * bucketMs).toISOString(),
  },
];

/** Keys from the domain's infrastructure: MX host set, nameserver set, registrar + registration-date bucket. */
export function domainClusterKeys(
  facts: DomainFacts | null,
  options: ClusterKeyOptions = DEFAULT_CLUSTER_KEY_OPTIONS
): ClusterKey[] {
  if (!facts) return [];
  const keys: ClusterKey[] = [];
  const mx = hostSet(facts.mxHosts, options.ignoredInfrastructureHosts);
  if (mx) keys.push({ kind: 'mx', value: mx, label: `MX hosts ${mx}` });
  const ns = hostSet(facts.nameservers, options.ignoredInfrastructureHosts);
  if (ns) keys.push({ kind: 'ns', value: ns, label: `nameservers ${ns}` });
  const registrar = facts.registrar?.trim().toLowerCase();
  const registeredAt = facts.registeredAt?.getTime();
  if (registrar && registeredAt !== undefined && !Number.isNaN(registeredAt)) {
    const days = options.registrationBucketDays;
    assertPositiveWidth('registrationBucketDays', days);
    for (const bucket of timeBuckets(registeredAt, days * DAY_MS)) {
      keys.push({
        kind: 'registration',
        value: `${registrar}|${bucket.id}`,
        label: `registrar ${registrar} with registration dates in the ${days}-day window from ${bucket.start}`,
      });
    }
  }
  return keys;
}

/** Keys from the user record alone: local-part shape, signup ASN and signup-time bucket. */
export function signupClusterKeys(
  record: SignupRecord,
  options: ClusterKeyOptions = DEFAULT_CLUSTER_KEY_OPTIONS
): ClusterKey[] {
  const keys: ClusterKey[] = [];
  const shape = record.localPartShape;
  if (shape && (options.localPartShapes === 'any' || options.localPartShapes.includes(shape))) {
    keys.push({ kind: 'localPartShape', value: shape, label: `local-part shape ${shape}` });
  }
  if (typeof record.asn === 'number' && Number.isFinite(record.asn)) {
    keys.push({ kind: 'asn', value: String(record.asn), label: `signup ASN ${record.asn}` });
  }
  const createdAt = record.createdAt?.getTime();
  if (createdAt !== undefined && !Number.isNaN(createdAt)) {
    const hours = options.signupBucketHours;
    assertPositiveWidth('signupBucketHours', hours);
    for (const bucket of timeBuckets(createdAt, hours * HOUR_MS)) {
      keys.push({
        kind: 'signupWindow',
        value: bucket.id,
        label: `signup times in the ${hours}-hour window from ${bucket.start}`,
      });
    }
  }
  return keys;
}

/**
 * Wraps a lookup so each domain is fetched once and lookup failures resolve to null (fail-open).
 * Failures are reported and not cached, so a later call retries them. Exceptions from a caller-supplied
 * error reporter propagate to the caller.
 */
export function cachedFailOpenLookup(
  lookup: DomainFactsLookup,
  onError: (domain: string, error: unknown) => void = (domain, error) => {
    console.warn(`[signup-cluster-keys] Domain facts lookup failed for ${domain}:`, error);
  }
): DomainFactsLookup {
  const cache = new Map<string, Promise<DomainFacts | null>>();
  return domain => {
    const cached = cache.get(domain);
    if (cached) return cached;
    const pending = Promise.resolve()
      .then(() => lookup(domain))
      .catch((error: unknown) => {
        cache.delete(domain);
        onError(domain, error);
        return null;
      });
    cache.set(domain, pending);
    return pending;
  };
}
