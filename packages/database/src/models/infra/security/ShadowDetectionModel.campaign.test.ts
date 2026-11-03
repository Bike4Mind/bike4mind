import { describe, it, expect, beforeEach } from 'vitest';
import type { AccountCampaignGroup, AccountCampaignMembership } from '@bike4mind/common';
import { setupMongoTest } from '../../../__test__/utils';
import {
  ShadowDetectionModel,
  shadowDetectionRepository,
  type RecordShadowDetectionInput,
} from './ShadowDetectionModel';

const id = (n: number) => n.toString(16).padStart(24, '0');
const HOUR = 60 * 60 * 1000;
const FIRST_RUN = new Date('2026-11-01T00:00:00Z');
const at = (hours: number) => new Date(FIRST_RUN.getTime() + hours * HOUR);

function group(members: [number, AccountCampaignMembership][], observedAt: Date): AccountCampaignGroup {
  const direct = members.filter(([, membership]) => membership === 'direct').map(([n]) => id(n));
  return {
    policyVersion: 1,
    window: { from: new Date(observedAt.getTime() - 72 * HOUR), to: observedAt },
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    members: members.map(([n, membership]) => ({ userId: id(n), membership, linkCount: 2, signedUpAt: FIRST_RUN })),
    links: [
      { userIds: [id(1), id(2)], relationships: ['fingerprint', 'lifecycle'] },
      { userIds: [id(1), id(3)], relationships: ['fingerprint', 'lifecycle'] },
    ],
    evidence: [
      {
        relationship: 'fingerprint',
        axis: 'client',
        value: 't13d1516h2_8daaf6152771_02713d6af862',
        label: 'Client fingerprint',
        population: direct.length,
        userIds: direct,
      },
    ],
    ignored: [],
    unknown: { fingerprint: 0, network: 0 },
    truncated: false,
    totals: { direct: direct.length, transitive: members.length - direct.length, links: 2 },
  };
}

const campaign = (members: [number, AccountCampaignMembership][], observedAt: Date): RecordShadowDetectionInput => {
  const evidence = group(members, observedAt);
  return {
    detector: 'accountCampaign',
    policyVersion: 1,
    wouldAction: 'contain',
    summary: `${evidence.totals.direct} accounts linked`,
    userIds: evidence.members.map(member => member.userId),
    network: null,
    signals: [],
    windowMinutes: 72 * 60,
    group: evidence,
    detectedAt: observedAt,
  };
};

const TRIO: [number, AccountCampaignMembership][] = [
  [1, 'direct'],
  [2, 'direct'],
  [3, 'direct'],
];

const stored = async () => (await shadowDetectionRepository.list({ limit: 10 })).data;

describe('shadowDetectionRepository campaign groups', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ShadowDetectionModel.deleteMany({});
  });

  it('updates an ungraded group in place and moves the revision only when membership changes', async () => {
    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(0)))).toBe('created');
    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(1)))).toBe('unchanged');

    let [record] = await stored();
    expect(record.revision).toBe(0);
    expect(record.detectedAt).toEqual(at(0));
    expect(record.group).toMatchObject({ firstObservedAt: at(0), lastObservedAt: at(1) });

    const grown: [number, AccountCampaignMembership][] = [...TRIO, [4, 'transitive']];
    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(grown, at(2)))).toBe('updated');

    const records = await stored();
    expect(records).toHaveLength(1);
    [record] = records;
    expect(record.revision).toBe(1);
    expect(record.userIds).toEqual([id(1), id(2), id(3), id(4)]);
    expect(record.group?.firstObservedAt).toEqual(at(0));
  });

  it('never rewrites a graded group, and opens a new record when new direct members join', async () => {
    await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(0)));
    const [graded] = await stored();
    await shadowDetectionRepository.addVerdict({
      id: graded.id,
      expectedRevision: 0,
      verdict: 'confirmed_abuse',
      reason: 'Same script',
      reviewerId: 'admin1',
    });

    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(1)))).toBe('unchanged');
    const [seen] = await stored();
    expect(seen).toMatchObject({ verdict: 'confirmed_abuse', revision: 1, userIds: graded.userIds });
    expect(seen.group?.lastObservedAt).toEqual(at(1));

    const grown: [number, AccountCampaignMembership][] = [...TRIO, [5, 'direct']];
    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(grown, at(2)))).toBe('created');
    expect((await stored()).map(record => record.verdict)).toEqual([null, 'confirmed_abuse']);
  });

  it('opens a new record for a new policy version or a group not seen for a week', async () => {
    await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(0)));

    expect(await shadowDetectionRepository.recordCampaignGroup({ ...campaign(TRIO, at(1)), policyVersion: 2 })).toBe(
      'created'
    );
    expect(await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(24 * 8)))).toBe('created');
    expect(await stored()).toHaveLength(3);
  });

  it('refuses a detection that is not a valid campaign group', async () => {
    const valid = campaign(TRIO, at(0));
    await expect(shadowDetectionRepository.recordCampaignGroup({ ...valid, group: null })).rejects.toThrow();
    await expect(
      shadowDetectionRepository.recordCampaignGroup({
        ...valid,
        group: { ...valid.group!, members: [{ ...valid.group!.members[0], userId: 'not-an-id' }] },
      })
    ).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });

  it('removes a deleted account from every detection and drops the records it leaves empty', async () => {
    await shadowDetectionRepository.recordCampaignGroup(campaign(TRIO, at(0)));
    await shadowDetectionRepository.record({
      detector: 'signupNetworkBurst',
      policyVersion: 1,
      wouldAction: 'contain',
      summary: '2 self-serve signups from one IP in 180 minutes',
      userIds: [id(1)],
      network: { ip: '203.0.113.7', asn: null, asnOrg: null, country: null, hosting: null },
      signals: [],
      windowMinutes: 180,
      group: null,
      detectedAt: at(0),
    });

    expect(await shadowDetectionRepository.removeUser(id(1))).toBe(1);

    const [remaining] = await stored();
    expect(remaining.detector).toBe('accountCampaign');
    expect(remaining.userIds).toEqual([id(2), id(3)]);
    expect(remaining.group?.members.map(member => member.userId)).toEqual([id(2), id(3)]);
    expect(remaining.group?.links).toEqual([]);
    expect(remaining.group?.evidence[0].userIds).toEqual([id(2), id(3)]);

    expect(await shadowDetectionRepository.removeUser(id(2))).toBe(1);
    expect(await stored()).toEqual([]);
    expect(await shadowDetectionRepository.removeUser(id(9))).toBe(0);
  });
});
