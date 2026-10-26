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
  type SignupRecord,
} from './signupClusterKeys';

/** Every value here is a caller decision; the defaults are neutral placeholders. */
export type CohortOptions = ClusterKeyOptions & {
  /** Two domains link when they share keys of at least this many distinct kinds. */
  minSharedKeyKinds: number;
  minDomains: number;
  /** A broad user key (ASN, signup bucket) on more domains than this is reported as common, not linked on. */
  maxDomainsPerKey: number;
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
  maxCohortDomains: 20,
  minUserKeyShare: 0.5,
  sharedMailboxDomains: [],
};

const CAPPED_KINDS: ReadonlySet<ClusterKeyKind> = new Set(['asn', 'signupWindow']);

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

const keyId = (key: ClusterKey) => `${key.kind}:${key.value}`;

const excludedDomainsOf = (options: CohortOptions) =>
  new Set([...DISALLOWED_SIGNUP_RULE_DOMAINS, ...options.sharedMailboxDomains.map(d => d.trim().toLowerCase())]);

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
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges = new Set<string>();
  const visit = (domain: string, parent: string | null) => {
    order.set(domain, order.size);
    low.set(domain, order.get(domain)!);
    let children = 0;
    for (const next of neighbors.get(domain)!) {
      if (next === parent) continue;
      if (order.has(next)) {
        low.set(domain, Math.min(low.get(domain)!, order.get(next)!));
        continue;
      }
      children += 1;
      visit(next, domain);
      low.set(domain, Math.min(low.get(domain)!, low.get(next)!));
      if (parent !== null && low.get(next)! >= order.get(domain)!) bridges.add(domain);
    }
    if (parent === null && children > 1) bridges.add(domain);
  };
  visit(domains[0], null);
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
  const domainsByKey = new Map<string, { key: ClusterKey; domains: string[] }>();
  for (const profile of profiles) {
    for (const key of profile.keys) {
      const entry = domainsByKey.get(keyId(key)) ?? { key, domains: [] };
      if (!entry.domains.includes(profile.domain)) entry.domains.push(profile.domain);
      domainsByKey.set(keyId(key), entry);
    }
  }
  const commonByLabel = new Map<string, number>();
  const linkingKeys = [...domainsByKey.values()].filter(({ key, domains }) => {
    if (domains.length < 2) return false;
    if (CAPPED_KINDS.has(key.kind) && domains.length > options.maxDomainsPerKey) {
      commonByLabel.set(key.label, Math.max(commonByLabel.get(key.label) ?? 0, domains.length));
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
  const find = (domain: string): string => {
    const up = parent.get(domain) ?? domain;
    if (up === domain) return domain;
    const root = find(up);
    parent.set(domain, root);
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
    const members = group.profiles.flatMap(profile =>
      profile.members.map(member => ({ userId: member.userId, domain: profile.domain, createdAt: member.createdAt }))
    );
    const tooBroad = domains.length > options.maxCohortDomains;
    const bridgeDomains = tooBroad
      ? []
      : findBridgeDomains(
          domains,
          group.edges.map(({ edge }) => edge)
        );

    const domainsByLabel = new Map<string, Set<string>>();
    for (const { edge, keys } of group.edges) {
      for (const key of keys) {
        const set = domainsByLabel.get(key.label) ?? new Set<string>();
        edge.domains.forEach(domain => set.add(domain));
        domainsByLabel.set(key.label, set);
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
        ...[...domainsByLabel]
          .map(([label, set]) => [label, set.size] as const)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label, count]) => `${count} domains share ${label}`),
      ],
    });
  }
  return {
    cohorts: cohorts.sort((a, b) => b.members.length - a.members.length || a.domains[0].localeCompare(b.domains[0])),
    commonKeys: [...commonByLabel]
      .map(([label, domainCount]) => ({ label, domainCount }))
      .sort((a, b) => b.domainCount - a.domainCount || a.label.localeCompare(b.label)),
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
