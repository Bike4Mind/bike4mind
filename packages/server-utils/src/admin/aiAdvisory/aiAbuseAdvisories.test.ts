import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShadowDetectionItem } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  listUnreviewedSince: vi.fn(),
  aggregate: vi.fn(),
  findUsers: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  shadowDetectionRepository: { listUnreviewedSince: h.listUnreviewedSince },
  AbuseAssessmentModel: { aggregate: h.aggregate },
  User: {
    find: (filter: unknown) => ({ select: () => ({ lean: () => h.findUsers(filter) }) }),
  },
  mongoose: {
    Types: {
      ObjectId: class {
        constructor(readonly id: string) {}
        toString() {
          return this.id;
        }
      },
    },
  },
}));

import { listAiAbuseAdvisories } from './aiAbuseAdvisories';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const ASSESSED = new Date('2026-11-05T11:00:00.000Z');
const userId = (n: number) => n.toString(16).padStart(24, '0');
const detectionId = (n: number) => `d${n}`.padStart(24, '0');

const detection = (overrides: Partial<ShadowDetectionItem> & { id: string }): ShadowDetectionItem => ({
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: 'test',
  userIds: [],
  network: null,
  signals: [],
  windowMinutes: null,
  group: null,
  payment: null,
  detectedAt: ASSESSED,
  verdict: null,
  verdicts: [],
  revision: 0,
  ...overrides,
});

const judgment = (id: string, result: string, abuse?: number, assessedAt = ASSESSED) => ({
  _id: id,
  result,
  probabilities: abuse === undefined ? [] : [{ value: 'abuse', probability: abuse }],
  assessedAt,
});

const network = (ip: string) => ({ ip, asn: 1, asnOrg: 'Org', country: 'EG', hosting: false });

describe('listAiAbuseAdvisories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every queried user exists and is not suspended unless a test says otherwise.
    h.findUsers.mockImplementation(async (filter: { _id: { $in: { id: string }[] } }) =>
      filter._id.$in.map(({ id }) => ({ _id: id }))
    );
  });

  it('looks back one day and returns nothing without detections', async () => {
    h.listUnreviewedSince.mockResolvedValue([]);
    const result = await listAiAbuseAdvisories(NOW);
    expect(h.listUnreviewedSince.mock.calls[0][0]).toEqual(new Date('2026-11-04T12:00:00.000Z'));
    expect(result).toMatchObject({ advisories: [], networks: [], mailDomains: [], truncated: false });
    expect(h.aggregate).not.toHaveBeenCalled();
  });

  it('keeps only detections whose latest settled judgment is abuse, strongest first', async () => {
    h.listUnreviewedSince.mockResolvedValue([
      detection({ id: detectionId(1), userIds: [userId(1)] }),
      detection({ id: detectionId(2), userIds: [userId(2)], detector: 'accountCampaign' }),
      detection({ id: detectionId(3), userIds: [userId(3)] }),
    ]);
    h.aggregate.mockResolvedValue([
      judgment(detectionId(1), 'abuse', 0.7),
      judgment(detectionId(2), 'abuse', 0.95),
      judgment(detectionId(3), 'legitimate_automation', 0.1),
    ]);
    const { advisories } = await listAiAbuseAdvisories(NOW);
    expect(advisories.map(advisory => [advisory.userId, advisory.detector, advisory.abuseProbability])).toEqual([
      [userId(2), 'accountCampaign', 0.95],
      [userId(1), 'signupNetworkBurst', 0.7],
    ]);
  });

  it('never lets an unknown result hide an earlier judgment', async () => {
    h.listUnreviewedSince.mockResolvedValue([detection({ id: detectionId(1), userIds: [userId(1)] })]);
    h.aggregate.mockResolvedValue([judgment(detectionId(1), 'abuse', 0.8)]);
    await listAiAbuseAdvisories(NOW);
    expect(h.aggregate.mock.calls[0][0][0]).toEqual({
      $match: { detectionId: { $in: [detectionId(1)] }, result: { $ne: 'unknown' } },
    });
  });

  it('gives an account in several detections its strongest one', async () => {
    h.listUnreviewedSince.mockResolvedValue([
      detection({ id: detectionId(1), userIds: [userId(1)] }),
      detection({ id: detectionId(2), userIds: [userId(1)], detector: 'youngAccountSpend' }),
    ]);
    h.aggregate.mockResolvedValue([judgment(detectionId(1), 'abuse', 0.6), judgment(detectionId(2), 'abuse', 0.9)]);
    const { advisories } = await listAiAbuseAdvisories(NOW);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toMatchObject({ detectionId: detectionId(2), detector: 'youngAccountSpend' });
  });

  it('drops suspended accounts, so containing them clears the advisory', async () => {
    h.listUnreviewedSince.mockResolvedValue([detection({ id: detectionId(1), userIds: [userId(1), userId(2)] })]);
    h.aggregate.mockResolvedValue([judgment(detectionId(1), 'abuse', 0.9)]);
    h.findUsers.mockResolvedValue([{ _id: userId(2) }]);
    const { advisories } = await listAiAbuseAdvisories(NOW);
    expect(h.findUsers.mock.calls[0][0]).toMatchObject({ isBanned: { $ne: true } });
    expect(advisories.map(advisory => advisory.userId)).toEqual([userId(2)]);
  });

  it('suggests an IP only when shared by two flagged accounts or a detector would block it', async () => {
    h.listUnreviewedSince.mockResolvedValue([
      detection({ id: detectionId(1), userIds: [userId(1), userId(2)], network: network('10.0.0.1') }),
      detection({ id: detectionId(2), userIds: [userId(3)], network: network('10.0.0.2') }),
      detection({ id: detectionId(3), userIds: [userId(4)], network: network('10.0.0.3'), wouldAction: 'blockIp' }),
    ]);
    h.aggregate.mockResolvedValue([
      judgment(detectionId(1), 'abuse', 0.9),
      judgment(detectionId(2), 'abuse', 0.9),
      judgment(detectionId(3), 'abuse', 0.9),
    ]);
    const { networks } = await listAiAbuseAdvisories(NOW);
    expect(networks.map(entry => [entry.ip, entry.accountCount, entry.detectorWouldBlock])).toEqual([
      ['10.0.0.1', 2, false],
      ['10.0.0.3', 1, true],
    ]);
  });

  it('suggests a campaign mail domain shared by two flagged, unsuspended accounts', async () => {
    const evidence = (value: string, userIds: string[]) => ({
      relationship: 'mailDomain' as const,
      axis: 'affiliation' as const,
      value,
      label: value,
      population: 2,
      userIds,
    });
    const group = (entries: ReturnType<typeof evidence>[]) =>
      ({ evidence: entries }) as unknown as ShadowDetectionItem['group'];
    h.listUnreviewedSince.mockResolvedValue([
      detection({
        id: detectionId(1),
        detector: 'accountCampaign',
        userIds: [userId(1), userId(2), userId(3)],
        group: group([evidence('example.test', [userId(1), userId(2)]), evidence('other.test', [userId(3)])]),
      }),
    ]);
    h.aggregate.mockResolvedValue([judgment(detectionId(1), 'abuse', 0.9)]);
    const { mailDomains } = await listAiAbuseAdvisories(NOW);
    expect(mailDomains).toEqual([{ domain: 'example.test', accountCount: 2 }]);
  });

  it('flags truncation when the detection scan hits its cap', async () => {
    h.listUnreviewedSince.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => detection({ id: detectionId(index), userIds: [] }))
    );
    h.aggregate.mockResolvedValue([]);
    const result = await listAiAbuseAdvisories(NOW);
    expect(result.truncated).toBe(true);
    expect(h.aggregate.mock.calls[0][0][0].$match.detectionId.$in).toHaveLength(500);
  });
});
