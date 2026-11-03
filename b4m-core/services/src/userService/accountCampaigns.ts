import {
  ACCOUNT_CAMPAIGN_AXIS_OF,
  ACCOUNT_CAMPAIGN_MIN_AXES,
  ACCOUNT_CAMPAIGN_POLICY_VERSION,
  type AccountCampaignEvidence,
  type AccountCampaignGroup,
  type AccountCampaignIgnored,
  type AccountCampaignIgnoredReason,
  type AccountCampaignLink,
  type AccountCampaignMember,
  type AccountCampaignRelationship,
  type ShadowDetectionItem,
} from '@bike4mind/common';

/**
 * Candidate coordinated-account groups from recent signups (contract: common/schemas/accountCampaign.ts).
 * Pure and deterministic: the same accounts, window and policy always give the same groups, so a run
 * can be replayed on fixtures. Shadow-only: the output is recorded for review and must never feed
 * signupRiskScore or riskScore.reviewState.
 *
 * 1. Accounts sharing a value (network prefix, hosting ASN, mail domain, JA4) are bucketed. A value
 *    held by too many scanned accounts, a known-common JA4 or a personal mail provider is ignored.
 * 2. A pair is linked only when its relationships cover ACCOUNT_CAMPAIGN_MIN_AXES independent axes, so
 *    no single signal (a shared JA4, one office network) links anyone.
 * 3. Groups are the connected parts of the links that sit in a triangle (a 3-truss): a lone link
 *    bridging two clusters is dropped, so association does not chain across a component. Accounts
 *    linked into a group but outside it are listed as transitive, one hop only.
 */

/** The data one scanned account contributes. Null means not captured: unknown, never a mismatch. */
export type CampaignAccount = {
  userId: string;
  signedUpAt: Date;
  /** Signup IPv4 /24 or IPv6 /48 prefix. */
  networkPrefix: string | null;
  asn: number | null;
  hosting: boolean | null;
  fingerprint: string | null;
  /** Registrable mail domain, lowercased. */
  mailDomain: string | null;
  lifecycle: { emailVerifiedAt: Date | null; firstApiKeyAt: Date | null; firstUsageAt: Date | null };
};

export type CampaignPolicy = {
  /** A value shared by more scanned accounts than this is common infrastructure, not evidence. */
  maxSharedPopulation: number;
  /** Signups further apart than this never form a lifecycle link (ms). */
  lifecycleSyncWindowMs: number;
  /** Two step offsets match when they differ by at most the larger of these. */
  lifecycleToleranceMs: number;
  lifecycleToleranceRatio: number;
  /** Candidate pairs considered per run; past this the scan stops and reports truncation. */
  maxCandidatePairs: number;
  /** Stored caps per group; totals keep the uncut counts. */
  maxDirectMembers: number;
  maxTransitiveMembers: number;
  maxStoredLinks: number;
  maxIgnoredValues: number;
};

export const DEFAULT_CAMPAIGN_POLICY: CampaignPolicy = {
  maxSharedPopulation: 25,
  lifecycleSyncWindowMs: 30 * 60_000,
  lifecycleToleranceMs: 2 * 60_000,
  lifecycleToleranceRatio: 0.1,
  maxCandidatePairs: 50_000,
  maxDirectMembers: 50,
  maxTransitiveMembers: 25,
  maxStoredLinks: 200,
  maxIgnoredValues: 10,
};

export type CampaignScanInput = {
  accounts: readonly CampaignAccount[];
  window: { from: Date; to: Date };
  /** JA4s known to be common over a longer baseline (findSignupFingerprintClusters). */
  commonFingerprints: ReadonlySet<string>;
  /** Personal mailbox providers; a shared one is never evidence. */
  personalMailDomains: ReadonlySet<string>;
  now: Date;
  policy?: CampaignPolicy;
};

export type CampaignScanStats = {
  accounts: number;
  candidatePairs: number;
  links: number;
  groups: number;
  /** True when maxCandidatePairs stopped pair generation; the groups found so far are still valid. */
  pairsTruncated: boolean;
};

export type CampaignScanResult = { groups: AccountCampaignGroup[]; stats: CampaignScanStats };

type ValueRelationship = Exclude<AccountCampaignRelationship, 'lifecycle'>;

type Bucket = {
  relationship: ValueRelationship;
  value: string;
  members: number[];
  ignored: AccountCampaignIgnoredReason | null;
};

const VALUE_LABELS: Record<ValueRelationship, (value: string) => string> = {
  networkPrefix: value => `Signup network ${value}`,
  hostingAsn: value => `Hosting network AS${value}`,
  mailDomain: value => `Mail domain ${value}`,
  fingerprint: value => `Client fingerprint ${value}`,
};

const LIFECYCLE_STEPS = ['emailVerifiedAt', 'firstApiKeyAt', 'firstUsageAt'] as const;
const LIFECYCLE_STEP_LABELS = {
  emailVerifiedAt: 'email verified',
  firstApiKeyAt: 'first API key',
  firstUsageAt: 'first usage',
} as const;

const compareAccounts = (left: CampaignAccount, right: CampaignAccount) =>
  left.signedUpAt.getTime() - right.signedUpAt.getTime() || left.userId.localeCompare(right.userId);

const pairKey = (left: number, right: number) => (left < right ? `${left}:${right}` : `${right}:${left}`);

function valueOf(account: CampaignAccount, relationship: ValueRelationship): string | null {
  switch (relationship) {
    case 'networkPrefix':
      return account.networkPrefix;
    case 'hostingAsn':
      return account.hosting === true && account.asn !== null ? String(account.asn) : null;
    case 'mailDomain':
      return account.mailDomain;
    case 'fingerprint':
      return account.fingerprint;
  }
}

function buildBuckets(
  accounts: readonly CampaignAccount[],
  input: CampaignScanInput,
  policy: CampaignPolicy
): Bucket[] {
  const relationships: ValueRelationship[] = ['networkPrefix', 'hostingAsn', 'mailDomain', 'fingerprint'];
  const buckets: Bucket[] = [];
  for (const relationship of relationships) {
    const byValue = new Map<string, number[]>();
    accounts.forEach((account, index) => {
      const value = valueOf(account, relationship);
      if (value === null) return;
      byValue.set(value, [...(byValue.get(value) ?? []), index]);
    });
    for (const [value, members] of [...byValue.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (members.length < 2) continue;
      buckets.push({ relationship, value, members, ignored: ignoredReason(relationship, value, members.length) });
    }
  }
  return buckets;

  function ignoredReason(
    relationship: ValueRelationship,
    value: string,
    population: number
  ): AccountCampaignIgnoredReason | null {
    if (relationship === 'mailDomain' && input.personalMailDomains.has(value)) return 'personalMailProvider';
    if (relationship === 'fingerprint' && input.commonFingerprints.has(value)) return 'common';
    return population > policy.maxSharedPopulation ? 'common' : null;
  }
}

/** Step offsets from signup (ms), or null when the account ran too few steps to compare. */
function lifecycleOffsets(account: CampaignAccount): (number | null)[] | null {
  const offsets = LIFECYCLE_STEPS.map(step => {
    const at = account.lifecycle[step];
    return at === null ? null : Math.max(0, at.getTime() - account.signedUpAt.getTime());
  });
  const present = offsets.filter(offset => offset !== null).length;
  // Email verification alone happens to almost everyone; at least one later step is required.
  const beyondVerification = offsets[1] !== null || offsets[2] !== null;
  return present >= 2 && beyondVerification ? offsets : null;
}

function lifecycleMatches(left: (number | null)[], right: (number | null)[], policy: CampaignPolicy): boolean {
  return left.every((offset, step) => {
    const other = right[step];
    if (offset === null || other === null) return offset === other;
    const tolerance = Math.max(policy.lifecycleToleranceMs, policy.lifecycleToleranceRatio * Math.max(offset, other));
    return Math.abs(offset - other) <= tolerance;
  });
}

type PairGraph = { relationships: Map<string, Set<AccountCampaignRelationship>>; truncated: boolean };

function collectPairs(
  accounts: readonly CampaignAccount[],
  buckets: readonly Bucket[],
  policy: CampaignPolicy
): PairGraph {
  const relationships = new Map<string, Set<AccountCampaignRelationship>>();
  let truncated = false;
  const add = (left: number, right: number, relationship: AccountCampaignRelationship): boolean => {
    const key = pairKey(left, right);
    const existing = relationships.get(key);
    if (existing) {
      existing.add(relationship);
      return true;
    }
    if (relationships.size >= policy.maxCandidatePairs) {
      truncated = true;
      return false;
    }
    relationships.set(key, new Set([relationship]));
    return true;
  };

  for (const bucket of buckets) {
    if (bucket.ignored) continue;
    for (let i = 0; i < bucket.members.length; i++) {
      for (let j = i + 1; j < bucket.members.length; j++) {
        if (!add(bucket.members[i], bucket.members[j], bucket.relationship)) return { relationships, truncated };
      }
    }
  }

  // Accounts are sorted by signup time, so the sync window is a forward scan.
  const offsets = accounts.map(lifecycleOffsets);
  for (let i = 0; i < accounts.length; i++) {
    const left = offsets[i];
    if (!left) continue;
    for (let j = i + 1; j < accounts.length; j++) {
      const gap = accounts[j].signedUpAt.getTime() - accounts[i].signedUpAt.getTime();
      if (gap > policy.lifecycleSyncWindowMs) break;
      const right = offsets[j];
      if (right && lifecycleMatches(left, right, policy) && !add(i, j, 'lifecycle')) {
        return { relationships, truncated };
      }
    }
  }
  return { relationships, truncated };
}

const axisCount = (relationships: Set<AccountCampaignRelationship>) =>
  new Set([...relationships].map(relationship => ACCOUNT_CAMPAIGN_AXIS_OF[relationship])).size;

type Adjacency = Map<number, Set<number>>;

function adjacencyOf(links: Iterable<[number, number]>): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const [left, right] of links) {
    adjacency.set(left, (adjacency.get(left) ?? new Set()).add(right));
    adjacency.set(right, (adjacency.get(right) ?? new Set()).add(left));
  }
  return adjacency;
}

/** Repeatedly drops links that close no triangle; what remains is the 3-truss. */
function trussLinks(links: [number, number][]): [number, number][] {
  let current = links;
  for (;;) {
    const adjacency = adjacencyOf(current);
    const kept = current.filter(([left, right]) => {
      const leftNeighbours = adjacency.get(left) ?? new Set<number>();
      for (const neighbour of adjacency.get(right) ?? []) if (leftNeighbours.has(neighbour)) return true;
      return false;
    });
    if (kept.length === current.length) return kept;
    current = kept;
  }
}

function components(links: [number, number][]): number[][] {
  const adjacency = adjacencyOf(links);
  const seen = new Set<number>();
  const result: number[][] = [];
  for (const start of [...adjacency.keys()].sort((left, right) => left - right)) {
    if (seen.has(start)) continue;
    const component: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const node = stack.pop() as number;
      component.push(node);
      for (const next of adjacency.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    result.push(component.sort((left, right) => left - right));
  }
  return result;
}

export function findAccountCampaigns(input: CampaignScanInput): CampaignScanResult {
  const policy = input.policy ?? DEFAULT_CAMPAIGN_POLICY;
  const unique = new Map(input.accounts.map(account => [account.userId, account]));
  const accounts = [...unique.values()].sort(compareAccounts);

  const buckets = buildBuckets(accounts, input, policy);
  const pairs = collectPairs(accounts, buckets, policy);
  const linkRelationships = new Map(
    [...pairs.relationships].filter(([, relationships]) => axisCount(relationships) >= ACCOUNT_CAMPAIGN_MIN_AXES)
  );
  const links = [...linkRelationships.keys()].map(key => key.split(':').map(Number) as [number, number]);
  const allAdjacency = adjacencyOf(links);

  const cores = components(trussLinks(links));
  const directAnywhere = new Set(cores.flat());
  const lifecycleParticipants = new Set(
    [...pairs.relationships]
      .filter(([, relationships]) => relationships.has('lifecycle'))
      .flatMap(([key]) => key.split(':').map(Number))
  ).size;

  const groups = cores
    .map(core =>
      buildGroup({
        core,
        accounts,
        buckets,
        linkRelationships,
        allAdjacency,
        directAnywhere,
        lifecycleParticipants,
        input,
        policy,
      })
    )
    .sort(
      (left, right) =>
        right.totals.direct - left.totals.direct || left.members[0].userId.localeCompare(right.members[0].userId)
    );

  return {
    groups,
    stats: {
      accounts: accounts.length,
      candidatePairs: pairs.relationships.size,
      links: links.length,
      groups: groups.length,
      pairsTruncated: pairs.truncated,
    },
  };
}

function buildGroup(context: {
  core: number[];
  accounts: readonly CampaignAccount[];
  buckets: readonly Bucket[];
  linkRelationships: Map<string, Set<AccountCampaignRelationship>>;
  allAdjacency: Adjacency;
  directAnywhere: Set<number>;
  lifecycleParticipants: number;
  input: CampaignScanInput;
  policy: CampaignPolicy;
}): AccountCampaignGroup {
  const { core, accounts, buckets, linkRelationships, allAdjacency, directAnywhere, input, policy } = context;
  const coreSet = new Set(core);
  const transitive = [
    ...new Set(core.flatMap(node => [...(allAdjacency.get(node) ?? [])]).filter(node => !directAnywhere.has(node))),
  ];

  const groupSet = new Set([...core, ...transitive]);
  const linkCount = (node: number) => [...(allAdjacency.get(node) ?? [])].filter(other => groupSet.has(other)).length;
  const byStrength = (left: number, right: number) =>
    linkCount(right) - linkCount(left) || compareAccounts(accounts[left], accounts[right]);
  const keptDirect = [...core].sort(byStrength).slice(0, policy.maxDirectMembers);
  const keptTransitive = transitive.sort(byStrength).slice(0, policy.maxTransitiveMembers);
  const kept = new Set([...keptDirect, ...keptTransitive]);

  const toMember = (node: number, membership: AccountCampaignMember['membership']): AccountCampaignMember => ({
    userId: accounts[node].userId,
    membership,
    linkCount: linkCount(node),
    signedUpAt: accounts[node].signedUpAt,
  });
  const members = [
    ...keptDirect.map(node => toMember(node, 'direct')),
    ...keptTransitive.map(node => toMember(node, 'transitive')),
  ];

  // Links touching the core; transitive-transitive links are not this group's evidence.
  const groupLinks = [...linkRelationships]
    .map(([key, relationships]) => ({ nodes: key.split(':').map(Number) as [number, number], relationships }))
    .filter(({ nodes }) => coreSet.has(nodes[0]) || coreSet.has(nodes[1]));
  const keptLinks = groupLinks.filter(({ nodes }) => kept.has(nodes[0]) && kept.has(nodes[1]));
  const storedLinks: AccountCampaignLink[] = keptLinks
    .map(({ nodes, relationships }) => {
      const userIds = nodes.map(node => accounts[node].userId).sort() as [string, string];
      return { userIds, relationships: [...relationships].sort() };
    })
    .sort((left, right) => left.userIds.join().localeCompare(right.userIds.join()))
    .slice(0, policy.maxStoredLinks);

  const keptNodes = [...kept];
  const evidence = groupEvidence(keptNodes, accounts, buckets, keptLinks, context.lifecycleParticipants, policy);
  const ignored = ignoredValues(keptNodes, buckets, policy);
  const memberAccounts = keptNodes.map(node => accounts[node]);

  return {
    policyVersion: ACCOUNT_CAMPAIGN_POLICY_VERSION,
    window: { from: input.window.from, to: input.window.to },
    firstObservedAt: input.now,
    lastObservedAt: input.now,
    members,
    links: storedLinks,
    evidence,
    ignored,
    unknown: {
      fingerprint: memberAccounts.filter(account => account.fingerprint === null).length,
      network: memberAccounts.filter(account => account.networkPrefix === null).length,
    },
    truncated:
      keptDirect.length < core.length ||
      keptTransitive.length < transitive.length ||
      storedLinks.length < groupLinks.length,
    totals: { direct: core.length, transitive: transitive.length, links: groupLinks.length },
  };
}

function groupEvidence(
  members: number[],
  accounts: readonly CampaignAccount[],
  buckets: readonly Bucket[],
  groupLinks: { nodes: [number, number]; relationships: Set<AccountCampaignRelationship> }[],
  lifecycleParticipants: number,
  policy: CampaignPolicy
): AccountCampaignEvidence[] {
  const memberSet = new Set(members);
  const userIdsOf = (nodes: Iterable<number>) => [...nodes].map(node => accounts[node].userId).sort();

  const shared: AccountCampaignEvidence[] = buckets
    .filter(bucket => !bucket.ignored)
    .map(bucket => ({ bucket, inGroup: bucket.members.filter(node => memberSet.has(node)) }))
    .filter(({ inGroup }) => inGroup.length >= 2)
    .map(({ bucket, inGroup }) => ({
      relationship: bucket.relationship,
      axis: ACCOUNT_CAMPAIGN_AXIS_OF[bucket.relationship],
      value: bucket.value,
      label: VALUE_LABELS[bucket.relationship](bucket.value),
      population: bucket.members.length,
      userIds: userIdsOf(inGroup),
    }));

  const lifecycleNodes = new Set(
    groupLinks.filter(link => link.relationships.has('lifecycle')).flatMap(link => link.nodes)
  );
  if (lifecycleNodes.size === 0) return shared;
  const minutes = Math.round(policy.lifecycleSyncWindowMs / 60_000);
  const steps = LIFECYCLE_STEPS.filter(step =>
    [...lifecycleNodes].every(node => accounts[node].lifecycle[step] !== null)
  ).map(step => LIFECYCLE_STEP_LABELS[step]);
  return [
    ...shared,
    {
      relationship: 'lifecycle',
      axis: ACCOUNT_CAMPAIGN_AXIS_OF.lifecycle,
      value: null,
      label: `Signed up within ${minutes} minutes of each other and ran the same steps at matching offsets (${steps.join(', ')})`,
      population: lifecycleParticipants,
      userIds: userIdsOf(lifecycleNodes),
    },
  ];
}

function ignoredValues(
  members: number[],
  buckets: readonly Bucket[],
  policy: CampaignPolicy
): AccountCampaignIgnored[] {
  const memberSet = new Set(members);
  return buckets
    .filter((bucket): bucket is Bucket & { ignored: AccountCampaignIgnoredReason } => bucket.ignored !== null)
    .map(bucket => ({
      relationship: bucket.relationship,
      value: bucket.value,
      population: bucket.members.length,
      reason: bucket.ignored,
      memberCount: bucket.members.filter(node => memberSet.has(node)).length,
    }))
    .filter(entry => entry.memberCount >= 2)
    .sort((left, right) => right.memberCount - left.memberCount || left.value.localeCompare(right.value))
    .slice(0, policy.maxIgnoredValues);
}

export const ACCOUNT_CAMPAIGN_RELATIONSHIP_LABELS: Record<AccountCampaignRelationship, string> = {
  networkPrefix: 'network prefix',
  hostingAsn: 'hosting network',
  mailDomain: 'mail domain',
  fingerprint: 'client fingerprint',
  lifecycle: 'lifecycle timing',
};

export type CampaignShadowDetection = Omit<ShadowDetectionItem, 'id' | 'verdict' | 'verdicts' | 'revision'>;

/**
 * The shadow detection a group is recorded as. wouldAction is what a gated policy might map it to; the
 * record itself acts on nobody.
 */
export function toCampaignShadowDetection(group: AccountCampaignGroup, windowMinutes: number): CampaignShadowDetection {
  const relationships = [...new Set(group.evidence.map(entry => entry.relationship))];
  const transitive = group.totals.transitive > 0 ? ` (+${group.totals.transitive} transitive)` : '';
  return {
    detector: 'accountCampaign',
    policyVersion: group.policyVersion,
    wouldAction: 'contain',
    summary: `${group.totals.direct} accounts linked by ${relationships
      .map(relationship => ACCOUNT_CAMPAIGN_RELATIONSHIP_LABELS[relationship])
      .join(', ')}${transitive}`,
    userIds: group.members.map(member => member.userId),
    network: null,
    signals: [
      { key: 'directMembers', label: 'Directly linked accounts', observed: group.totals.direct, threshold: 3 },
      {
        key: 'transitiveMembers',
        label: 'Transitively linked accounts',
        observed: group.totals.transitive,
        threshold: null,
      },
      { key: 'links', label: 'Direct links', observed: group.totals.links, threshold: null },
      {
        key: 'axes',
        label: 'Independent evidence axes',
        observed: new Set(group.evidence.map(entry => entry.axis)).size,
        threshold: ACCOUNT_CAMPAIGN_MIN_AXES,
      },
    ],
    windowMinutes,
    group,
    detectedAt: group.lastObservedAt,
  };
}
