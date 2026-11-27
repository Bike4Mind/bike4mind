import { describe, expect, it } from 'vitest';
import { accountCampaignSummary, withoutCampaignMember, type AccountCampaignGroup } from './accountCampaign';

const id = (n: number) => n.toString(16).padStart(24, '0');
const AT = new Date('2026-11-01T00:00:00Z');
const FINGERPRINT = 't13d1516h2_8daaf6152771_02713d6af862';

/** Direct core 1-4 (every pair linked), transitive 5 linked only to 1, transitive 6 linked to 2. */
const group = (): AccountCampaignGroup => {
  const pairs: [number, number][] = [
    [1, 2],
    [1, 3],
    [1, 4],
    [2, 3],
    [2, 4],
    [3, 4],
    [1, 5],
    [2, 6],
  ];
  const linkCount = (n: number) => pairs.filter(pair => pair.includes(n)).length;
  return {
    policyVersion: 1,
    window: { from: AT, to: AT },
    firstObservedAt: AT,
    lastObservedAt: AT,
    members: [1, 2, 3, 4, 5, 6].map(n => ({
      userId: id(n),
      membership: n <= 4 ? 'direct' : 'transitive',
      linkCount: linkCount(n),
      signedUpAt: AT,
    })),
    links: pairs.map(([left, right]) => ({
      userIds: [id(left), id(right)] as [string, string],
      relationships: ['fingerprint', 'lifecycle'],
    })),
    evidence: [
      {
        relationship: 'fingerprint',
        axis: 'client',
        value: FINGERPRINT,
        label: `Client fingerprint ${FINGERPRINT}`,
        population: 6,
        userIds: [1, 2, 3, 4, 5, 6].map(id),
      },
      {
        relationship: 'mailDomain',
        axis: 'affiliation',
        value: 'burner.example',
        label: 'Mail domain burner.example',
        population: 2,
        userIds: [id(1), id(5)],
      },
    ],
    ignored: [
      {
        relationship: 'mailDomain',
        value: 'gmail.com',
        population: 300,
        reason: 'personalMailProvider',
        memberCount: 6,
      },
    ],
    unknown: { fingerprint: 0, network: 6 },
    truncated: false,
    totals: { direct: 4, transitive: 2, links: 8 },
  };
};

describe('withoutCampaignMember', () => {
  it('drops the account, the transitive members only it linked, and evidence no longer shared', () => {
    const pruned = withoutCampaignMember(group(), id(1));

    expect(pruned?.members.map(member => [member.userId, member.membership, member.linkCount])).toEqual([
      [id(2), 'direct', 3],
      [id(3), 'direct', 2],
      [id(4), 'direct', 2],
      [id(6), 'transitive', 1],
    ]);
    expect(pruned?.links.some(link => link.userIds.includes(id(1)) || link.userIds.includes(id(5)))).toBe(false);
    expect(pruned?.evidence.map(entry => [entry.relationship, entry.userIds])).toEqual([
      ['fingerprint', [2, 3, 4, 6].map(id)],
    ]);
    expect(pruned?.ignored[0].memberCount).toBe(4);
    expect(pruned?.unknown).toEqual({ fingerprint: 0, network: 4 });
    expect(pruned?.totals).toEqual({ direct: 3, transitive: 1, links: 4 });
    expect(pruned && accountCampaignSummary(pruned)).toBe('3 accounts linked by client fingerprint (+1 transitive)');
  });

  it('keeps the core intact when a transitive member is deleted', () => {
    const pruned = withoutCampaignMember(group(), id(6));

    expect(pruned?.totals).toEqual({ direct: 4, transitive: 1, links: 7 });
    expect(pruned?.members.find(member => member.userId === id(2))?.linkCount).toBe(3);
  });

  it('returns null once fewer than three direct members are left', () => {
    const pruned = withoutCampaignMember(group(), id(1));

    expect(pruned && withoutCampaignMember(pruned, id(2))).toBeNull();
  });
});
