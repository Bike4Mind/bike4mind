import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import {
  ShadowDetectionModel,
  shadowDetectionRepository,
  type RecordShadowDetectionInput,
} from './ShadowDetectionModel';

const detection = (overrides: Partial<RecordShadowDetectionInput> = {}): RecordShadowDetectionInput => ({
  detector: 'signupNetworkBurst',
  policyVersion: 1,
  wouldAction: 'contain',
  summary: '3 self-serve signups from one IP in 180 minutes',
  userIds: ['u1'],
  network: { ip: '203.0.113.7', asn: 64500, asnOrg: 'Example Cloud', country: 'US', hosting: true },
  signals: [{ key: 'ipSignups', label: 'Signups from this IP', observed: 3, threshold: 1 }],
  windowMinutes: 180,
  detectedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const grade = (id: string, expectedRevision: number, verdict: 'confirmed_abuse' | 'legitimate_human') =>
  shadowDetectionRepository.addVerdict({
    id,
    expectedRevision,
    verdict,
    reason: 'Checked the cohort',
    reviewerId: 'admin1',
  });

describe('shadowDetectionRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await ShadowDetectionModel.deleteMany({});
  });

  it('records a detection and lists it unreviewed', async () => {
    const id = await shadowDetectionRepository.record(detection());

    const { data, truncated } = await shadowDetectionRepository.list({ limit: 10 });
    expect(truncated).toBe(false);
    expect(data).toEqual([
      {
        id,
        ...detection(),
        verdict: null,
        verdicts: [],
        revision: 0,
      },
    ]);
  });

  it('lists newest first, filters by detector and verdict, and reports truncation', async () => {
    const older = await shadowDetectionRepository.record(detection({ detectedAt: new Date('2026-10-01T00:00:00Z') }));
    const newer = await shadowDetectionRepository.record(detection({ detectedAt: new Date('2026-10-02T00:00:00Z') }));
    await grade(older, 0, 'confirmed_abuse');

    const all = await shadowDetectionRepository.list({ limit: 10 });
    expect(all.data.map(item => item.id)).toEqual([newer, older]);

    const capped = await shadowDetectionRepository.list({ limit: 1 });
    expect(capped).toMatchObject({ truncated: true, data: [{ id: newer }] });

    const unreviewed = await shadowDetectionRepository.list({ verdict: 'unreviewed', limit: 10 });
    expect(unreviewed.data.map(item => item.id)).toEqual([newer]);

    const confirmed = await shadowDetectionRepository.list({
      detector: 'signupNetworkBurst',
      verdict: 'confirmed_abuse',
      limit: 10,
    });
    expect(confirmed.data.map(item => item.id)).toEqual([older]);
  });

  it('adds a verdict and bumps the revision', async () => {
    const id = await shadowDetectionRepository.record(detection());

    const result = await grade(id, 0, 'confirmed_abuse');

    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    expect(result.item.verdict).toBe('confirmed_abuse');
    expect(result.item.revision).toBe(1);
    expect(result.item.verdicts).toEqual([
      { verdict: 'confirmed_abuse', reason: 'Checked the cohort', reviewerId: 'admin1', reviewedAt: expect.any(Date) },
    ]);
  });

  it('rejects a stale revision with the current record and leaves it unchanged', async () => {
    const id = await shadowDetectionRepository.record(detection());
    await grade(id, 0, 'confirmed_abuse');

    const result = await grade(id, 0, 'legitimate_human');

    expect(result).toMatchObject({ status: 'conflict', item: { id, verdict: 'confirmed_abuse', revision: 1 } });
    const stored = await ShadowDetectionModel.findById(id).lean();
    expect(stored?.verdicts).toHaveLength(1);
  });

  it('keeps earlier verdicts when a correction is appended', async () => {
    const id = await shadowDetectionRepository.record(detection());
    await grade(id, 0, 'confirmed_abuse');

    const result = await grade(id, 1, 'legitimate_human');

    expect(result).toMatchObject({ status: 'updated', item: { verdict: 'legitimate_human', revision: 2 } });
    if (result.status !== 'updated') return;
    expect(result.item.verdicts.map(entry => entry.verdict)).toEqual(['confirmed_abuse', 'legitimate_human']);
  });

  it('reports a missing record as not found', async () => {
    await expect(grade('a'.repeat(24), 0, 'confirmed_abuse')).resolves.toEqual({ status: 'not_found' });
  });

  it('summarizes counts per detector and policy version on the latest verdict', async () => {
    const [first, second] = await Promise.all([
      shadowDetectionRepository.record(detection()),
      shadowDetectionRepository.record(detection()),
      shadowDetectionRepository.record(detection()),
      shadowDetectionRepository.record(detection({ policyVersion: 2 })),
    ]);
    await grade(first, 0, 'confirmed_abuse');
    await grade(second, 0, 'confirmed_abuse');
    await grade(second, 1, 'legitimate_human');

    await expect(shadowDetectionRepository.summarize()).resolves.toEqual([
      {
        detector: 'signupNetworkBurst',
        policyVersion: 2,
        recorded: 1,
        confirmedAbuse: 0,
        legitimateHuman: 0,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
      {
        detector: 'signupNetworkBurst',
        policyVersion: 1,
        recorded: 3,
        confirmedAbuse: 1,
        legitimateHuman: 1,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
    ]);
  });

  it('declares the retention TTL on detectedAt', async () => {
    const ttl = ShadowDetectionModel.schema.indexes().find(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(ttl).toEqual([{ detectedAt: 1 }, expect.objectContaining({ expireAfterSeconds: 365 * 24 * 60 * 60 })]);
  });
});
