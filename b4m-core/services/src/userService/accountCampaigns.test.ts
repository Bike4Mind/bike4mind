import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMPAIGN_POLICY,
  findAccountCampaigns,
  toCampaignShadowDetection,
  type CampaignAccount,
  type CampaignScanInput,
} from './accountCampaigns';

const START = new Date('2026-10-30T00:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RARE_JA4 = 't13d1516h2_8daaf6152771_02713d6af862';
const OTHER_RARE_JA4 = 't13d1517h2_8daaf6152771_b1ff8ab2d16f';
const POPULAR_JA4 = 't13d1516h2_8daaf6152771_e5627efa2ab1';

const userId = (n: number) => n.toString(16).padStart(24, '0');

/** An account that shares nothing with any other: its own network, a personal mailbox, no steps. */
function account(n: number, overrides: Partial<Omit<CampaignAccount, 'lifecycle'>> & { steps?: number[] } = {}) {
  const { steps, ...rest } = overrides;
  const signedUpAt = rest.signedUpAt ?? new Date(START.getTime() + n * 3 * HOUR);
  const at = (offset: number | undefined) =>
    offset === undefined || offset < 0 ? null : new Date(signedUpAt.getTime() + offset);
  return {
    userId: userId(n),
    signedUpAt,
    networkPrefix: `198.51.${n}.0`,
    asn: 64500 + n,
    hosting: false,
    fingerprint: null,
    mailDomain: 'gmail.com',
    ...rest,
    lifecycle: { emailVerifiedAt: at(steps?.[0]), firstApiKeyAt: at(steps?.[1]), firstUsageAt: at(steps?.[2]) },
  } satisfies CampaignAccount;
}

const scan = (accounts: CampaignAccount[], overrides: Partial<CampaignScanInput> = {}) =>
  findAccountCampaigns({
    accounts,
    window: { from: START, to: new Date(START.getTime() + 72 * HOUR) },
    commonFingerprints: new Set([POPULAR_JA4]),
    personalMailDomains: new Set(['gmail.com', 'outlook.com']),
    now: new Date(START.getTime() + 72 * HOUR),
    ...overrides,
  });

const burstAt = (n: number) => new Date(START.getTime() + n * MINUTE);

/** Rotating residential IPs and a personal mailbox, but one automated client and one scripted lifecycle. */
const rotatingCampaign = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) =>
    account(from + i, {
      signedUpAt: burstAt(from + i),
      fingerprint: RARE_JA4,
      steps: [20_000 + i * 1000, 3 * MINUTE + i * 2000, 4 * MINUTE + i * 2000],
    })
  );

describe('findAccountCampaigns', () => {
  it('groups rotating-IP accounts that share an uncommon client and a synchronized lifecycle', () => {
    const { groups } = scan(rotatingCampaign(1, 5));

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.members.map(member => member.membership)).toEqual(Array(5).fill('direct'));
    expect(group.totals).toEqual({ direct: 5, transitive: 0, links: 10 });
    expect(group.evidence.map(entry => entry.relationship).sort()).toEqual(['fingerprint', 'lifecycle']);
    expect(group.links.every(link => link.relationships.join() === 'fingerprint,lifecycle')).toBe(true);
    expect(group.ignored).toEqual([
      { relationship: 'mailDomain', value: 'gmail.com', population: 5, reason: 'personalMailProvider', memberCount: 5 },
    ]);
    expect(group.unknown).toEqual({ fingerprint: 0, network: 0 });
  });

  it('does not link unrelated users who share a popular browser fingerprint', () => {
    const crowd = Array.from({ length: 40 }, (_, i) =>
      account(i + 1, { fingerprint: OTHER_RARE_JA4, signedUpAt: burstAt(i * 7), steps: [i * 5000, (i + 3) * MINUTE] })
    );
    const knownCommon = Array.from({ length: 5 }, (_, i) =>
      account(100 + i, { fingerprint: POPULAR_JA4, mailDomain: 'same-startup.example' })
    );

    const result = scan([...crowd, ...knownCommon]);

    expect(result.groups).toEqual([]);
  });

  it('does not group a school or company network on affiliation alone', () => {
    const school = Array.from({ length: 15 }, (_, i) =>
      account(i + 1, {
        networkPrefix: '203.0.113.0',
        mailDomain: 'school.example.edu',
        fingerprint: POPULAR_JA4,
        signedUpAt: new Date(START.getTime() + i * 47 * MINUTE),
        steps: [i * 9000, (5 + i * 11) * MINUTE],
      })
    );

    expect(scan(school).groups).toEqual([]);
  });

  it('does not group independent API clients on a shared cloud network', () => {
    const clients = Array.from({ length: 10 }, (_, i) =>
      account(i + 1, {
        asn: 16509,
        hosting: true,
        fingerprint: POPULAR_JA4,
        mailDomain: `client-${i}.example`,
        steps: [10_000, MINUTE, 2 * MINUTE],
      })
    );

    expect(scan(clients).groups).toEqual([]);
  });

  it('cannot see a randomized-timing campaign that shares nothing else, and still finds one that does', () => {
    const random = [5, 41, 13, 77, 29].map((spread, i) =>
      account(i + 1, {
        signedUpAt: burstAt(i),
        fingerprint: POPULAR_JA4,
        steps: [0, spread * MINUTE, (spread + 50) * MINUTE],
      })
    );
    expect(scan(random).groups).toEqual([]);

    const withSharedInfra = random.map(entry => ({ ...entry, fingerprint: RARE_JA4, mailDomain: 'burner.example' }));
    const [group] = scan(withSharedInfra).groups;
    expect(group.totals.direct).toBe(5);
    expect(group.evidence.map(entry => entry.relationship).sort()).toEqual(['fingerprint', 'mailDomain']);
  });

  it('lists a one-link neighbour as transitive and leaves a two-hop account out', () => {
    const core = [0, 1, 2].map(i =>
      account(i + 1, {
        signedUpAt: burstAt(i),
        fingerprint: RARE_JA4,
        mailDomain: i === 0 ? 'shared.example' : `own-${i}.example`,
        steps: i === 0 ? [0, 180_000, 240_000] : [0, 60_000, 120_000],
      })
    );
    const neighbour = account(4, {
      signedUpAt: burstAt(3),
      mailDomain: 'shared.example',
      networkPrefix: '192.0.2.0',
      steps: [0, 300_000, 360_000],
    });
    const twoHops = account(5, { signedUpAt: burstAt(4), networkPrefix: '192.0.2.0', steps: [0, 420_000, 480_000] });

    const [group] = scan([...core, neighbour, twoHops]).groups;

    expect(group.members.map(member => [member.userId, member.membership, member.linkCount])).toEqual([
      [userId(1), 'direct', 3],
      [userId(2), 'direct', 2],
      [userId(3), 'direct', 2],
      [userId(4), 'transitive', 1],
    ]);
    expect(group.links).toContainEqual({ userIds: [userId(1), userId(4)], relationships: ['lifecycle', 'mailDomain'] });
    expect(group.unknown.fingerprint).toBe(1);
  });

  it('splits two clusters joined by a single bridging link', () => {
    const cluster = (from: number, fingerprint: string, domain: string) =>
      [0, 1, 2].map(i => account(from + i, { fingerprint, mailDomain: domain }));
    const left = cluster(1, RARE_JA4, 'left.example');
    const right = cluster(4, OTHER_RARE_JA4, 'right.example');
    left[2] = { ...left[2], networkPrefix: '192.0.2.0', signedUpAt: burstAt(0) };
    left[2].lifecycle = { emailVerifiedAt: null, firstApiKeyAt: burstAt(2), firstUsageAt: burstAt(3) };
    right[0] = { ...right[0], networkPrefix: '192.0.2.0', signedUpAt: burstAt(1) };
    right[0].lifecycle = { emailVerifiedAt: null, firstApiKeyAt: burstAt(3), firstUsageAt: burstAt(4) };

    const { groups } = scan([...left, ...right]);

    expect(groups.map(group => group.members.map(member => member.userId).sort())).toEqual([
      [userId(1), userId(2), userId(3)],
      [userId(4), userId(5), userId(6)],
    ]);
    expect(groups.every(group => group.totals.transitive === 0)).toBe(true);
    expect(groups.map(group => [group.totals.links, group.links.length, group.truncated])).toEqual([
      [3, 3, false],
      [3, 3, false],
    ]);
  });

  it('keeps two clusters that share one account as two groups', () => {
    const steps = [20_000, 3 * MINUTE, 4 * MINUTE];
    // Accounts 1-3 share a client and a network; accounts 3-5 share a mail domain and a scripted
    // lifecycle. Only account 3 is in both.
    const accounts = [
      account(1, { fingerprint: RARE_JA4, networkPrefix: '198.18.0.0' }),
      account(2, { fingerprint: RARE_JA4, networkPrefix: '198.18.0.0' }),
      account(3, {
        fingerprint: RARE_JA4,
        networkPrefix: '198.18.0.0',
        mailDomain: 'right.example',
        signedUpAt: burstAt(10),
        steps,
      }),
      account(4, { mailDomain: 'right.example', signedUpAt: burstAt(11), steps }),
      account(5, { mailDomain: 'right.example', signedUpAt: burstAt(12), steps }),
    ];

    const { groups } = scan(accounts);

    const memberSets = groups.map(group => group.members.map(member => member.userId).sort()).sort();
    expect(memberSets).toEqual([
      [userId(1), userId(2), userId(3)],
      [userId(3), userId(4), userId(5)],
    ]);
    expect(groups.flatMap(group => group.members).every(member => member.membership === 'direct')).toBe(true);
  });

  it('does not group a classroom that signs up on one network and onboards the usual way', () => {
    const classroom = Array.from({ length: 12 }, (_, i) =>
      account(i + 1, {
        networkPrefix: '203.0.113.0',
        signedUpAt: burstAt(i),
        steps: [60_000 + i * 5000, -1, 3 * MINUTE + i * 5000],
      })
    );

    expect(scan(classroom).groups).toEqual([]);
  });

  it('keeps missing fingerprints unknown rather than counting them as a match or a mismatch', () => {
    const accounts = rotatingCampaign(1, 4).map(entry => ({
      ...entry,
      fingerprint: null,
      mailDomain: 'burner.example',
    }));

    const [group] = scan(accounts).groups;

    expect(group.unknown).toEqual({ fingerprint: 4, network: 0 });
    expect(group.evidence.map(entry => entry.relationship).sort()).toEqual(['lifecycle', 'mailDomain']);
  });

  it('enforces the stored group size and the candidate pair budget', () => {
    const big = rotatingCampaign(1, 8);

    const [group] = scan(big, {
      policy: { ...DEFAULT_CAMPAIGN_POLICY, maxDirectMembers: 5, maxStoredLinks: 4 },
    }).groups;
    expect(group.members).toHaveLength(5);
    expect(group.links).toHaveLength(4);
    expect(group.totals).toEqual({ direct: 8, transitive: 0, links: 28 });
    expect(group.truncated).toBe(true);

    const budgeted = scan(big, { policy: { ...DEFAULT_CAMPAIGN_POLICY, maxCandidatePairs: 3 } });
    expect(budgeted.stats).toMatchObject({ candidatePairs: 3, pairsTruncated: true });
  });

  it('keeps adding evidence to open pairs once the pair budget is spent', () => {
    const neighbours = [100, 101].map(n => account(n, { networkPrefix: '192.0.2.0' }));

    const { groups, stats } = scan([...neighbours, ...rotatingCampaign(1, 5)], {
      policy: { ...DEFAULT_CAMPAIGN_POLICY, maxCandidatePairs: 10 },
    });

    expect(stats.pairsTruncated).toBe(true);
    expect(groups.map(group => group.totals.direct)).toEqual([5]);
  });

  it('treats a value shared beyond the population cap as common', () => {
    const accounts = rotatingCampaign(1, 5);

    const { groups } = scan(accounts, { policy: { ...DEFAULT_CAMPAIGN_POLICY, maxSharedPopulation: 4 } });

    expect(groups).toEqual([]);
  });

  it('is deterministic regardless of input order and duplicate rows', () => {
    const accounts = [
      ...rotatingCampaign(1, 5),
      ...rotatingCampaign(20, 4).map(entry => ({ ...entry, fingerprint: OTHER_RARE_JA4 })),
    ];
    const shuffled = [accounts[7], ...accounts.slice(0, 7).reverse(), accounts[8], accounts[3]];

    expect(scan(shuffled)).toEqual(scan(accounts));
  });
});

describe('toCampaignShadowDetection', () => {
  it('records a group as an observation-only accountCampaign detection', () => {
    const [group] = scan(rotatingCampaign(1, 5)).groups;

    const detection = toCampaignShadowDetection(group, 72 * 60);

    expect(detection).toMatchObject({
      detector: 'accountCampaign',
      policyVersion: 1,
      summary: '5 accounts linked by client fingerprint, lifecycle timing',
      userIds: group.members.map(member => member.userId),
      network: null,
      windowMinutes: 72 * 60,
      group,
      detectedAt: group.lastObservedAt,
    });
    expect(detection.signals.find(signal => signal.key === 'axes')).toMatchObject({ observed: 2, threshold: 2 });
  });
});
