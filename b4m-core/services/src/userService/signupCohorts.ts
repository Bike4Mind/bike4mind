import { DISALLOWED_SIGNUP_RULE_DOMAINS } from '@bike4mind/common';
import {
  DEFAULT_CLUSTER_KEY_OPTIONS,
  domainClusterKeys,
  signupClusterKeys,
  type ClusterKey,
  type ClusterKeyKind,
  type ClusterKeyOptions,
  type DomainFacts,
  type DomainFactsLookup,
  normalizeRegistrableDomain,
  type SignupRecord,
} from './signupClusterKeys';

/** Every value here is a caller decision; the defaults are neutral placeholders. */
export type CohortOptions = ClusterKeyOptions & {
  /** Two domains link when they share keys of at least this many distinct kinds. */
  minSharedKeyKinds: number;
  minDomains: number;
  /** A broad user key (ASN, signup bucket) on more domains than this is reported as common, not linked on. */
  maxDomainsPerKey: number;
  /** MX, nameserver, registrar and shape keys on more domains than this are reported as common; bounds pair enumeration. */
  maxDomainsPerInfraKey: number;
  /** Larger cohorts are reported as too broad for review instead of as one group. */
  maxCohortDomains: number;
  /** A per-user key describes a domain once this share of its users carry it. */
  minUserKeyShare: number;
  /** Shared mailbox provider domains to skip, on top of DISALLOWED_SIGNUP_RULE_DOMAINS. */
  sharedMailboxDomains: readonly string[];
};

export const DEFAULT_COHORT_OPTIONS: CohortOptions = {
  ...DEFAULT_CLUSTER_KEY_OPTIONS,
  minSharedKeyKinds: 2,
  minDomains: 2,
  maxDomainsPerKey: 50,
  maxDomainsPerInfraKey: 500,
  maxCohortDomains: 20,
  minUserKeyShare: 0.5,
  sharedMailboxDomains: [],
};

const BROAD_KINDS: ReadonlySet<ClusterKeyKind> = new Set(['asn', 'signupWindow']);

export type DomainProfile = { domain: string; members: SignupRecord[]; keys: ClusterKey[] };

export type CohortEdge = { domains: [string, string]; kinds: ClusterKeyKind[] };

export type CohortMember = { userId: string; domain: string; createdAt: Date | null };

export type CandidateCohort = {
  domains: string[];
  members: CohortMember[];
  datacenterSignups: number;
  edges: CohortEdge[];
  /** Domains whose removal splits the cohort; empty for a too-broad cohort, which is not analyzed. */
  bridgeDomains: string[];
  tooBroad: boolean;
  reasons: string[];
};

export type CommonKey = { label: string; domainCount: number };

export type SignupGroupingResult = { cohorts: CandidateCohort[]; commonKeys: CommonKey[] };

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Orders members by domain, then signup time (no time last), then user id, so output ignores input order.
const compareMembers = (a: CohortMember, b: CohortMember) =>
  compareText(a.domain, b.domain) ||
  (a.createdAt?.getTime() ?? Infinity) - (b.createdAt?.getTime() ?? Infinity) ||
  compareText(a.userId, b.userId);

const keyId = (key: ClusterKey) => `${key.kind}:${key.value}`;

const excludedDomainsOf = (options: CohortOptions) =>
  new Set([
    ...DISALLOWED_SIGNUP_RULE_DOMAINS,
    ...options.sharedMailboxDomains.flatMap(entry => normalizeRegistrableDomain(entry) ?? []),
  ]);

/** One profile per registrable domain: its infrastructure keys plus the per-user keys most of its users share. */
export function buildDomainProfiles(
  records: readonly SignupRecord[],
  factsByDomain: ReadonlyMap<string, DomainFacts | null>,
  options: CohortOptions = DEFAULT_COHORT_OPTIONS
): DomainProfile[] {
  const excluded = excludedDomainsOf(options);
  const byDomain = new Map<string, SignupRecord[]>();
  for (const record of records) {
    if (!record.domain || excluded.has(record.domain)) continue;
    const group = byDomain.get(record.domain);
    if (group) group.push(record);
    else byDomain.set(record.domain, [record]);
  }
  return [...byDomain].map(([domain, members]) => {
    const userKeyCounts = new Map<string, { key: ClusterKey; count: number }>();
    for (const member of members) {
      for (const key of new Map(signupClusterKeys(member, options).map(k => [keyId(k), k])).values()) {
        const entry = userKeyCounts.get(keyId(key)) ?? { key, count: 0 };
        entry.count += 1;
        userKeyCounts.set(keyId(key), entry);
      }
    }
    const userKeys = [...userKeyCounts.values()]
      .filter(({ count }) => count / members.length >= options.minUserKeyShare)
      .map(({ key }) => key);
    return { domain, members, keys: [...domainClusterKeys(factsByDomain.get(domain) ?? null, options), ...userKeys] };
  });
}

function findBridgeDomains(domains: readonly string[], edges: readonly CohortEdge[]): string[] {
  const neighbors = new Map(domains.map(domain => [domain, [] as string[]]));
  for (const {
    domains: [a, b],
  } of edges) {
    neighbors.get(a)!.push(b);
    neighbors.get(b)!.push(a);
  }
  type Frame = { domain: string; parent: string | null; nextNeighbor: number; children: number };
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<string>();
  const enter = (domain: string, parent: string | null): Frame => {
    order.set(domain, order.size);
    low.set(domain, order.get(domain)!);
    return { domain, parent, nextNeighbor: 0, children: 0 };
  };
  for (const root of domains) {
    if (order.has(root)) continue;
    const stack: Frame[] = [enter(root, null)];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const adjacent = neighbors.get(frame.domain)!;
      if (frame.nextNeighbor < adjacent.length) {
        const next = adjacent[frame.nextNeighbor++];
        if (next === frame.parent) continue;
        if (order.has(next)) {
          low.set(frame.domain, Math.min(low.get(frame.domain)!, order.get(next)!));
        } else {
          frame.children += 1;
          stack.push(enter(next, frame.domain));
        }
        continue;
      }
      stack.pop();
      if (frame.parent === null) {
        if (frame.children > 1) bridges.add(frame.domain);
        continue;
      }
      const parentFrame = stack[stack.length - 1];
      low.set(frame.parent, Math.min(low.get(frame.parent)!, low.get(frame.domain)!));
      if (parentFrame.parent !== null && low.get(frame.domain)! >= order.get(frame.parent)!) {
        bridges.add(frame.parent);
      }
    }
  }
  return [...bridges].sort();
}

/**
 * Links domains that share enough distinct key kinds. Cohorts are connected components, so A-B and B-C
 * put A and C together even when they share nothing; `edges` and `bridgeDomains` show how.
 */
export function groupDomainProfiles(
  profiles: readonly DomainProfile[],
  options: CohortOptions = DEFAULT_COHORT_OPTIONS
): SignupGroupingResult {
  const domainsByKey = new Map<string, { key: ClusterKey; domains: Set<string> }>();
  for (const profile of profiles) {
    for (const key of profile.keys) {
      const entry = domainsByKey.get(keyId(key)) ?? { key, domains: new Set<string>() };
      entry.domains.add(profile.domain);
      domainsByKey.set(keyId(key), entry);
    }
  }
  const commonKeyList: CommonKey[] = [];
  const linkingKeys = [...domainsByKey.values()].filter(({ key, domains }) => {
    if (domains.size < 2) return false;
    const cap = BROAD_KINDS.has(key.kind) ? options.maxDomainsPerKey : options.maxDomainsPerInfraKey;
    if (domains.size > cap) {
      commonKeyList.push({ label: key.label, domainCount: domains.size });
      return false;
    }
    return true;
  });

  const sharedKeys = new Map<string, ClusterKey[]>();
  for (const { key, domains } of linkingKeys) {
    const sorted = [...domains].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const pair = `${sorted[i]}\n${sorted[j]}`;
        const keys = sharedKeys.get(pair);
        if (keys) keys.push(key);
        else sharedKeys.set(pair, [key]);
      }
    }
  }

  const parent = new Map<string, string>();
  // Iterative: a long chain of pairs builds a parent chain as deep as the domain count.
  const find = (domain: string): string => {
    let root = domain;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    for (let node = domain; node !== root;) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const edges: { edge: CohortEdge; keys: ClusterKey[] }[] = [];
  const linked = new Set<string>();
  for (const [pair, keys] of sharedKeys) {
    const kinds = [...new Set(keys.map(key => key.kind))].sort();
    if (kinds.length < options.minSharedKeyKinds) continue;
    const [a, b] = pair.split('\n');
    edges.push({ edge: { domains: [a, b], kinds }, keys });
    linked.add(a).add(b);
    parent.set(find(a), find(b));
  }

  const groups = new Map<string, { profiles: DomainProfile[]; edges: typeof edges }>();
  for (const profile of profiles) {
    if (!linked.has(profile.domain)) continue;
    const root = find(profile.domain);
    const group = groups.get(root) ?? { profiles: [], edges: [] };
    group.profiles.push(profile);
    groups.set(root, group);
  }
  for (const entry of edges) groups.get(find(entry.edge.domains[0]))!.edges.push(entry);

  const cohorts: CandidateCohort[] = [];
  for (const group of groups.values()) {
    if (group.profiles.length < options.minDomains) continue;
    const domains = group.profiles.map(profile => profile.domain).sort();
    const members = group.profiles
      .flatMap(profile =>
        profile.members.map(member => ({ userId: member.userId, domain: profile.domain, createdAt: member.createdAt }))
      )
      .sort(compareMembers);
    group.edges.sort((a, b) => compareText(a.edge.domains.join(','), b.edge.domains.join(',')));
    const tooBroad = domains.length > options.maxCohortDomains;
    const bridgeDomains = tooBroad
      ? []
      : findBridgeDomains(
          domains,
          group.edges.map(({ edge }) => edge)
        );

    const domainsByKeyId = new Map<string, { label: string; domains: Set<string> }>();
    for (const { edge, keys } of group.edges) {
      for (const key of keys) {
        const entry = domainsByKeyId.get(keyId(key)) ?? { label: key.label, domains: new Set<string>() };
        edge.domains.forEach(domain => entry.domains.add(domain));
        domainsByKeyId.set(keyId(key), entry);
      }
    }
    cohorts.push({
      domains,
      members,
      datacenterSignups: group.profiles.reduce(
        (sum, profile) => sum + profile.members.filter(member => member.isDatacenter === true).length,
        0
      ),
      edges: group.edges.map(({ edge }) => edge),
      bridgeDomains,
      tooBroad,
      reasons: [
        tooBroad
          ? `too broad: ${domains.length} domains exceeds ${options.maxCohortDomains}, review edges`
          : `cohort of ${domains.length} domains, ${members.length} users`,
        ...(bridgeDomains.length ? [`connectivity depends on ${bridgeDomains.join(', ')}`] : []),
        ...[...domainsByKeyId.values()]
          .map(({ label, domains: shared }) => [label, shared.size] as const)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, count]) => `${count} domains share ${label}`),
      ],
    });
  }
  return {
    cohorts: cohorts.sort((a, b) => b.members.length - a.members.length || a.domains[0].localeCompare(b.domains[0])),
    commonKeys: commonKeyList.sort((a, b) => b.domainCount - a.domainCount || a.label.localeCompare(b.label)),
  };
}

/** Resolves each distinct domain's facts through the lookup (wrap it in cachedFailOpenLookup) and groups. */
export async function findCandidateCohorts(
  records: readonly SignupRecord[],
  lookup: DomainFactsLookup | null,
  options: CohortOptions = DEFAULT_COHORT_OPTIONS
): Promise<SignupGroupingResult> {
  const factsByDomain = new Map<string, DomainFacts | null>();
  if (lookup) {
    const excluded = excludedDomainsOf(options);
    for (const { domain } of records) {
      if (domain && !excluded.has(domain) && !factsByDomain.has(domain)) {
        factsByDomain.set(domain, await lookup(domain));
      }
    }
  }
  return groupDomainProfiles(buildDomainProfiles(records, factsByDomain, options), options);
}
