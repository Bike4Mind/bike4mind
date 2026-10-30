import { emailDomain } from '@client/app/utils/signupAnomaly';
import { type DomainSignupSignal, type SignupSignal, SIGNUP_SIGNALS } from '@client/app/utils/signupSignals';
import { deliveryMailbox } from '@server/utils/deliveryMailbox';
import { ipv6Slash64 } from '@server/utils/ipv6Slash64';

/**
 * Deterministic suspected-signup classifier. Every account gets the list of signals it triggered
 * (never a bare verdict) so an admin can see why it was flagged; `isSuspectedSignup` in
 * app/utils/signupSignals.ts turns that list into the suspected/likely-legit split.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const BURST_WINDOW_MS = HOUR_MS;
/** Accounts on one non-webmail domain inside BURST_WINDOW_MS that make a burst. */
export const BURST_MIN_ACCOUNTS = 12;
/** A gap longer than this ends a domain's run of signups for the cadence check. */
export const CADENCE_MAX_GAP_MS = 2 * HOUR_MS;
export const CADENCE_MIN_ACCOUNTS = 10;
export const CADENCE_MIN_SPAN_MS = HOUR_MS;
/**
 * Coefficient of variation of the gaps between signups. Independent human arrivals are close to a
 * Poisson process (CV near 1); a script sleeping a jittered interval sits well under 0.5.
 */
export const CADENCE_MAX_GAP_CV = 0.5;
export const PATTERN_WINDOW_MS = DAY_MS;
export const PATTERN_MIN_ACCOUNTS = 5;
/** Letters and separators a template must keep once digits are masked, so `#` or `a#` never match. */
export const PATTERN_MIN_FIXED_CHARS = 4;
export const EARLY_API_KEY_MS = DAY_MS;
/** Accounts younger than this are not judged on dormancy yet. */
export const DORMANCY_MIN_AGE_MS = DAY_MS;
/** Activity this soon after signup still counts as the first session. */
export const FIRST_SESSION_MS = HOUR_MS;
/** Trailing hours whose median signup count is an hour's baseline for the spike check. */
export const SPIKE_BASELINE_HOURS = 28 * 24;
/** An hour is a spike at SPIKE_FACTOR times its baseline, and never below SPIKE_MIN_ACCOUNTS signups. */
export const SPIKE_FACTOR = 10;
export const SPIKE_MIN_ACCOUNTS = 10;
export const SHARED_NETWORK_WINDOW_MS = DAY_MS;
/** Accounts from one /24 (IPv4) or /64 (IPv6) inside SHARED_NETWORK_WINDOW_MS that share a network. */
export const SHARED_NETWORK_MIN_ACCOUNTS = 3;

/**
 * Consumer webmail: volume on one of these is just popularity, so burst and cadence never apply to
 * them. A platform-wide surge, webmail included, is signupSpike's job instead.
 * Generic providers only; abusive domains are never listed here or anywhere in this repo.
 */
export const MAJOR_WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'mail.ru',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'zoho.com',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
]);

export type SignupCandidate = {
  id: string;
  email: string | null;
  createdAt: Date;
  lastActiveAt?: Date | null;
  signupMeta?: { ip?: string | null; isDatacenter?: boolean | null; wafBotSignal?: boolean | null } | null;
  /** Earliest API key the account created, if any. */
  firstApiKeyAt?: Date | null;
  /** Latest use of any of the account's API keys; REST traffic never touches lastActiveAt. */
  lastApiUseAt?: Date | null;
};

type CohortMember = Pick<SignupCandidate, 'id' | 'email' | 'createdAt'>;
type ClusterMember = Pick<SignupCandidate, 'id' | 'email' | 'createdAt' | 'signupMeta'>;

const addSignal = <T extends SignupSignal>(signals: Map<string, Set<T>>, id: string, signal: T) => {
  const set = signals.get(id) ?? new Set();
  set.add(signal);
  signals.set(id, set);
};

const pushTo = <T>(groups: Map<string, T[]>, key: string, item: T) => {
  const group = groups.get(key);
  if (group) group.push(item);
  else groups.set(key, [item]);
};

/** Ids of members (sorted by createdAt) that fall in any `windowMs` window holding `minCount` of them. */
function membersOfDenseWindows(
  members: Pick<CohortMember, 'id' | 'createdAt'>[],
  windowMs: number,
  minCount: number
): string[] {
  const hit = new Set<string>();
  let start = 0;
  for (let end = 0; end < members.length; end++) {
    while (members[end].createdAt.getTime() - members[start].createdAt.getTime() >= windowMs) start++;
    if (end - start + 1 >= minCount) for (let i = start; i <= end; i++) hit.add(members[i].id);
  }
  return [...hit];
}

function isRegularRun(run: CohortMember[]): boolean {
  if (run.length < CADENCE_MIN_ACCOUNTS) return false;
  const span = run[run.length - 1].createdAt.getTime() - run[0].createdAt.getTime();
  if (span < CADENCE_MIN_SPAN_MS) return false;
  const gaps = run.slice(1).map((member, i) => member.createdAt.getTime() - run[i].createdAt.getTime());
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const variance = gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean <= CADENCE_MAX_GAP_CV;
}

/** Runs of consecutive signups no more than CADENCE_MAX_GAP_MS apart. */
function splitRuns(members: CohortMember[]): CohortMember[][] {
  const runs: CohortMember[][] = [];
  for (const member of members) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (previous && member.createdAt.getTime() - previous.createdAt.getTime() <= CADENCE_MAX_GAP_MS) run.push(member);
    else runs.push([member]);
  }
  return runs;
}

/** `prefix-123-456` and `prefix-77-9` share the template `prefix-#-#`; null when nothing fixed is left. */
export function localPartTemplate(email: string | null): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  if (!email || at <= 0) return null;
  const local = email.slice(0, at).toLowerCase().split('+')[0];
  if (!/\d/.test(local)) return null;
  const template = local.replace(/\d+/g, '#');
  return template.replace(/#/g, '').length >= PATTERN_MIN_FIXED_CHARS ? template : null;
}

/**
 * Domain-level signals for a cohort of signups, keyed by account id. Burst and cadence skip major
 * webmail; the address template applies to every domain but is only a weak signal.
 */
export function classifyDomainCohorts(users: CohortMember[]): Map<string, Set<DomainSignupSignal>> {
  const byDomain = new Map<string, CohortMember[]>();
  for (const user of users) {
    pushTo(byDomain, emailDomain(user.email), user);
  }
  const signals = new Map<string, Set<DomainSignupSignal>>();
  for (const [domain, members] of byDomain) {
    members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (!MAJOR_WEBMAIL_DOMAINS.has(domain) && domain !== '(unknown)') {
      for (const id of membersOfDenseWindows(members, BURST_WINDOW_MS, BURST_MIN_ACCOUNTS)) {
        addSignal(signals, id, 'domainBurst');
      }
      for (const run of splitRuns(members)) {
        if (isRegularRun(run)) run.forEach(member => addSignal(signals, member.id, 'domainCadence'));
      }
    }
    const byTemplate = new Map<string, CohortMember[]>();
    for (const member of members) {
      const template = localPartTemplate(member.email);
      if (template) pushTo(byTemplate, template, member);
    }
    for (const group of byTemplate.values()) {
      for (const id of membersOfDenseWindows(group, PATTERN_WINDOW_MS, PATTERN_MIN_ACCOUNTS)) {
        addSignal(signals, id, 'patternedEmail');
      }
    }
  }
  return signals;
}

/** The /24 of an IPv4 address or the /64 of an IPv6 one; null when the address does not parse. */
export function networkPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const address = ip
    .trim()
    .split('%')[0]
    .replace(/^::ffff:(?=\d+\.)/i, '');
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (ipv4)
    return ipv4.slice(1).some(octet => Number(octet) > 255) ? null : `${ipv4.slice(1).map(Number).join('.')}.0/24`;
  return ipv6Slash64(address);
}

/**
 * Network and inbox signals for a cohort of signups, keyed by account id. Both apply to webmail too:
 * a farm on Gmail shares a network range or rotates dots and plus-tags on one inbox. Weak signals.
 */
export function classifySignupClusters(users: ClusterMember[]): Map<string, Set<SignupSignal>> {
  const byNetwork = new Map<string, ClusterMember[]>();
  const byMailbox = new Map<string, ClusterMember[]>();
  for (const user of users) {
    const network = networkPrefix(user.signupMeta?.ip);
    if (network) pushTo(byNetwork, network, user);
    if (user.email) pushTo(byMailbox, deliveryMailbox(user.email), user);
  }
  const signals = new Map<string, Set<SignupSignal>>();
  for (const members of byNetwork.values()) {
    members.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const id of membersOfDenseWindows(members, SHARED_NETWORK_WINDOW_MS, SHARED_NETWORK_MIN_ACCOUNTS)) {
      addSignal(signals, id, 'sharedNetwork');
    }
  }
  for (const members of byMailbox.values()) {
    if (members.length > 1) members.forEach(member => addSignal(signals, member.id, 'aliasedEmail'));
  }
  return signals;
}

/**
 * Starts of the hours whose signup count is a spike against the median of the SPIKE_BASELINE_HOURS
 * before it. `hourlyCounts` is keyed by UTC hour start (ms) and must reach back SPIKE_BASELINE_HOURS
 * before the first hour being judged; a missing hour counts as zero.
 */
export function spikeHours(hourlyCounts: ReadonlyMap<number, number>): Set<number> {
  const spikes = new Set<number>();
  for (const [hour, count] of hourlyCounts) {
    if (count < SPIKE_MIN_ACCOUNTS) continue;
    const history = Array.from(
      { length: SPIKE_BASELINE_HOURS },
      (_, i) => hourlyCounts.get(hour - (i + 1) * HOUR_MS) ?? 0
    ).sort((a, b) => a - b);
    if (count >= SPIKE_FACTOR * history[Math.floor(history.length / 2)]) spikes.add(hour);
  }
  return spikes;
}

const hourStart = (date: Date) => Math.floor(date.getTime() / HOUR_MS) * HOUR_MS;

/**
 * Signals for one account, given the signals its cohort produced. Missing signupMeta is no signal, but
 * a null lastActiveAt is: the account never came back after signup.
 */
export function classifySignup(
  user: SignupCandidate,
  cohortSignals: ReadonlySet<SignupSignal> = new Set(),
  now = new Date()
): SignupSignal[] {
  const createdAt = user.createdAt.getTime();
  const found = new Set<SignupSignal>(cohortSignals);
  if (user.signupMeta?.wafBotSignal === true) found.add('wafBotSignal');
  if (user.signupMeta?.isDatacenter === true) found.add('datacenterNetwork');
  if (user.firstApiKeyAt && user.firstApiKeyAt.getTime() - createdAt <= EARLY_API_KEY_MS) found.add('earlyApiKey');
  const usedApiLater = !!user.lastApiUseAt && user.lastApiUseAt.getTime() - createdAt > FIRST_SESSION_MS;
  if (
    now.getTime() - createdAt >= DORMANCY_MIN_AGE_MS &&
    (!user.lastActiveAt || user.lastActiveAt.getTime() - createdAt <= FIRST_SESSION_MS) &&
    !usedApiLater
  ) {
    found.add('dormantAfterSignup');
  }
  return SIGNUP_SIGNALS.filter(signal => found.has(signal));
}

/** `hourlyCounts` feeds the spike check (see spikeHours); without it no account is in a spike. */
export function classifySignups(
  users: SignupCandidate[],
  now = new Date(),
  hourlyCounts: ReadonlyMap<number, number> = new Map()
): Map<string, SignupSignal[]> {
  const domainSignals = classifyDomainCohorts(users);
  const clusterSignals = classifySignupClusters(users);
  const spikes = spikeHours(hourlyCounts);
  return new Map(
    users.map(user => {
      const cohortSignals = new Set<SignupSignal>([
        ...(domainSignals.get(user.id) ?? []),
        ...(clusterSignals.get(user.id) ?? []),
      ]);
      if (spikes.has(hourStart(user.createdAt))) cohortSignals.add('signupSpike');
      return [user.id, classifySignup(user, cohortSignals, now)];
    })
  );
}
