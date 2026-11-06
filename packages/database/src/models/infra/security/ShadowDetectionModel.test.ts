import { describe, it, expect, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import { setupMongoTest } from '../../../__test__/utils';
import { User } from '../../auth/UserModel';
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
  group: null,
  payment: null,
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

  it('round-trips the payment evidence of a paymentRisk detection', async () => {
    const paymentDetection = detection({
      detector: 'paymentRisk',
      wouldAction: 'contain',
      network: null,
      payment: {
        paymentIntentId: 'pi_1',
        chargeId: null,
        kind: 'subscription',
        outcome: 'failed',
        amount: null,
        currency: null,
        riskLevel: null,
        livemode: true,
      },
    });
    const id = await shadowDetectionRepository.record(paymentDetection);

    const { data } = await shadowDetectionRepository.list({ detector: 'paymentRisk', limit: 10 });
    expect(data).toEqual([{ id, ...paymentDetection, verdict: null, verdicts: [], revision: 0 }]);
  });

  it('reads a record written before payment evidence existed as having none', async () => {
    const { payment: _payment, ...legacy } = detection();
    await ShadowDetectionModel.collection.insertOne({ ...legacy, verdict: null, verdicts: [], revision: 0 });

    const { data } = await shadowDetectionRepository.list({ limit: 10 });
    expect(data[0]?.payment).toBeNull();
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

  it('counts open detections for a user, leaving out those judged legitimate', async () => {
    await shadowDetectionRepository.record(detection({ userIds: ['u1', 'u2'] }));
    await grade(await shadowDetectionRepository.record(detection({ userIds: ['u1'] })), 0, 'confirmed_abuse');
    await grade(await shadowDetectionRepository.record(detection({ userIds: ['u1'] })), 0, 'legitimate_human');
    await ShadowDetectionModel.updateOne(
      { _id: await shadowDetectionRepository.record(detection({ userIds: ['u1'] })) },
      { $set: { verdict: 'legitimate_automation' } }
    );

    expect(await shadowDetectionRepository.countOpenForUser('u1')).toBe(2);
    expect(await shadowDetectionRepository.countOpenForUser('u2')).toBe(1);
    expect(await shadowDetectionRepository.countOpenForUser('u3')).toBe(0);
  });

  it('adds a verdict and bumps the revision', async () => {
    const id = await shadowDetectionRepository.record(detection());

    const result = await grade(id, 0, 'confirmed_abuse');

    expect(result.status).toBe('updated');
    if (result.status !== 'updated') return;
    expect(result.item.verdict).toBe('confirmed_abuse');
    expect(result.item.revision).toBe(1);
    expect(result.item.verdicts).toEqual([
      {
        verdict: 'confirmed_abuse',
        reason: 'Checked the cohort',
        reviewerId: 'admin1',
        reviewedAt: expect.any(Date),
        source: 'review',
      },
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
        noAction: 0,
        confirmedAbuse: 0,
        legitimateHuman: 0,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
      {
        detector: 'signupNetworkBurst',
        policyVersion: 1,
        recorded: 3,
        noAction: 0,
        confirmedAbuse: 1,
        legitimateHuman: 1,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
    ]);
  });

  it('counts would-not-act records as recorded but keeps their verdicts out of precision', async () => {
    const [acted, notActed] = await Promise.all([
      shadowDetectionRepository.record(detection({ detector: 'signupDomainHold', wouldAction: 'confirmHold' })),
      shadowDetectionRepository.record(detection({ detector: 'signupDomainHold', wouldAction: 'none' })),
      shadowDetectionRepository.record(detection({ detector: 'signupDomainHold', wouldAction: 'none' })),
    ]);
    await grade(acted, 0, 'confirmed_abuse');
    await grade(notActed, 0, 'legitimate_human');

    await expect(shadowDetectionRepository.summarize()).resolves.toEqual([
      {
        detector: 'signupDomainHold',
        policyVersion: 1,
        recorded: 3,
        noAction: 2,
        confirmedAbuse: 1,
        legitimateHuman: 0,
        legitimateAutomation: 0,
        insufficientEvidence: 0,
      },
    ]);
    const listed = await shadowDetectionRepository.list({ detector: 'signupDomainHold', limit: 10 });
    expect(listed.data).toHaveLength(3);
  });

  it('excludes detectors in the unreviewed query so they never take a slot from the limit', async () => {
    const since = new Date('2026-09-01T00:00:00Z');
    const older = await shadowDetectionRepository.record(detection({ detectedAt: new Date('2026-10-01T00:00:00Z') }));
    await Promise.all(
      [2, 3, 4].map(day =>
        shadowDetectionRepository.record(
          detection({
            detector: 'signupDomainHold',
            wouldAction: 'none',
            detectedAt: new Date(`2026-10-0${day}T00:00:00Z`),
          })
        )
      )
    );

    const unfiltered = await shadowDetectionRepository.listUnreviewedSince(since, 1);
    expect(unfiltered[0]?.detector).toBe('signupDomainHold');

    const filtered = await shadowDetectionRepository.listUnreviewedSince(since, 1, {
      excludeDetectors: ['signupDomainHold'],
    });
    expect(filtered.map(item => item.id)).toEqual([older]);
  });

  it('declares the retention TTL on detectedAt', async () => {
    const ttl = ShadowDetectionModel.schema.indexes().find(([, options]) => options?.expireAfterSeconds !== undefined);
    expect(ttl).toEqual([{ detectedAt: 1 }, expect.objectContaining({ expireAfterSeconds: 365 * 24 * 60 * 60 })]);
  });

  describe('account status verdicts', () => {
    const SUSPENDED = 'Abuse / automated signups';
    const REINSTATED = 'Suspended in error';
    const userId = new Types.ObjectId().toString();
    const peerId = new Types.ObjectId().toString();

    beforeEach(async () => {
      await User.collection.deleteMany({});
    });

    const suspend = () =>
      shadowDetectionRepository.gradeForSuspension({ userId, reason: SUSPENDED, reviewerId: 'admin1' });
    const reinstate = () =>
      shadowDetectionRepository.gradeForReinstatement({ userId, reason: REINSTATED, reviewerId: 'admin2' });
    const stored = async (id: string) => (await shadowDetectionRepository.findById(id))!;

    it('grades every ungraded detection naming a suspended account confirmed abuse', async () => {
      const burst = await shadowDetectionRepository.record(detection({ userIds: [userId, peerId] }));
      const spend = await shadowDetectionRepository.record(
        detection({ detector: 'youngAccountSpend', userIds: [userId], network: null })
      );
      const unrelated = await shadowDetectionRepository.record(detection({ userIds: [peerId] }));

      const graded = await suspend();

      expect(graded.map(item => item.id).sort()).toEqual([burst, spend].sort());
      expect((await stored(burst)).verdicts).toEqual([
        {
          verdict: 'confirmed_abuse',
          reason: SUSPENDED,
          reviewerId: 'admin1',
          reviewedAt: expect.any(Date),
          source: 'suspension',
        },
      ]);
      expect(await stored(spend)).toMatchObject({ verdict: 'confirmed_abuse', revision: 1 });
      expect(await stored(unrelated)).toMatchObject({ verdict: null, revision: 0 });
    });

    it('leaves a detection a reviewer already graded untouched on suspension', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await grade(id, 0, 'legitimate_human');

      expect(await suspend()).toEqual([]);
      expect(await stored(id)).toMatchObject({ verdict: 'legitimate_human', revision: 1 });
    });

    it('appends legitimate human use after the suspension verdict on reinstatement', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await suspend();

      const graded = await reinstate();

      expect(graded.map(item => item.id)).toEqual([id]);
      const item = await stored(id);
      expect(item.verdict).toBe('legitimate_human');
      expect(item.verdicts.map(entry => [entry.verdict, entry.source])).toEqual([
        ['confirmed_abuse', 'suspension'],
        ['legitimate_human', 'reinstatement'],
      ]);
    });

    it('grades an ungraded detection legitimate human use on reinstatement', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));

      await reinstate();

      expect(await stored(id)).toMatchObject({ verdict: 'legitimate_human', revision: 1 });
    });

    it('never overrides a reviewer verdict on reinstatement, including one from before sources existed', async () => {
      const reviewed = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await grade(reviewed, 0, 'confirmed_abuse');
      const legacy = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await ShadowDetectionModel.updateOne(
        { _id: legacy },
        {
          $set: { verdict: 'insufficient_evidence', revision: 1 },
          $push: {
            verdicts: { verdict: 'insufficient_evidence', reason: 'Old', reviewerId: 'a', reviewedAt: new Date() },
          },
        }
      );

      expect(await reinstate()).toEqual([]);
      expect(await stored(reviewed)).toMatchObject({ verdict: 'confirmed_abuse', revision: 1 });
      expect(await stored(legacy)).toMatchObject({ verdict: 'insufficient_evidence', revision: 1 });
    });

    it('keeps a burst graded while another account in it is still suspended', async () => {
      await User.collection.insertOne({ _id: new Types.ObjectId(peerId), isBanned: true });
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId, peerId] }));
      await suspend();

      expect(await reinstate()).toEqual([]);
      expect(await stored(id)).toMatchObject({ verdict: 'confirmed_abuse', revision: 1 });
    });

    it('grades a detection confirmed abuse again when the account is suspended after a reinstatement', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await suspend();
      await reinstate();

      expect((await suspend()).map(item => item.id)).toEqual([id]);
      expect(await stored(id)).toMatchObject({ verdict: 'confirmed_abuse', revision: 3 });
    });

    it('does not repeat confirmed abuse on a second suspension', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await suspend();

      expect(await suspend()).toEqual([]);
      expect((await stored(id)).verdicts).toHaveLength(1);
    });

    it('does not repeat legitimate human use on a second reinstatement', async () => {
      const id = await shadowDetectionRepository.record(detection({ userIds: [userId] }));
      await reinstate();

      expect(await reinstate()).toEqual([]);
      expect((await stored(id)).verdicts).toHaveLength(1);
    });
  });

  describe('list context', () => {
    const at = (iso: string) => new Date(iso);
    const insertUser = (fields: Record<string, unknown>) => {
      const _id = new Types.ObjectId();
      return User.collection.insertOne({ _id, ...fields }).then(() => _id.toString());
    };

    beforeEach(async () => {
      await User.collection.deleteMany({});
    });

    it('reports each named account status, signup method and balance', async () => {
      const active = await insertUser({ currentCredits: 120, acquisition: { signupMethod: 'google' } });
      const suspended = await insertUser({ isBanned: true, currentCredits: 0, authProviders: [{ strategy: 'github' }] });
      const deleted = await insertUser({ deletedAt: new Date() });
      const missing = new Types.ObjectId().toString();
      const id = await shadowDetectionRepository.record(
        detection({ detector: 'youngAccountSpend', network: null, userIds: [active, suspended, deleted, missing] })
      );

      const { accounts } = await shadowDetectionRepository.listContext([(await shadowDetectionRepository.findById(id))!]);

      expect(accounts).toEqual([
        { userId: active, status: 'active', signupMethod: 'google', currentCredits: 120 },
        { userId: suspended, status: 'suspended', signupMethod: 'github', currentCredits: 0 },
        { userId: deleted, status: 'deleted', signupMethod: 'email', currentCredits: null },
        { userId: missing, status: 'missing', signupMethod: null, currentCredits: null },
      ]);
    });

    it('lists the other signups from a burst IP inside its window, with their accounts', async () => {
      const ip = '203.0.113.7';
      const actor = await insertUser({ signupMeta: { ip }, createdAt: at('2026-10-01T00:00:00Z') });
      const peer = await insertUser({ signupMeta: { ip }, createdAt: at('2026-09-30T23:00:00Z') });
      await insertUser({ signupMeta: { ip }, createdAt: at('2026-09-29T00:00:00Z') });
      await insertUser({ signupMeta: { ip: '198.51.100.1' }, createdAt: at('2026-09-30T23:30:00Z') });
      const id = await shadowDetectionRepository.record(detection({ userIds: [actor], windowMinutes: 180 }));

      const context = await shadowDetectionRepository.listContext([(await shadowDetectionRepository.findById(id))!]);

      expect(context.burstPeers).toEqual([{ detectionId: id, userIds: [peer], truncated: false }]);
      expect(context.accounts.map(account => account.userId)).toEqual([actor, peer]);
    });
  });

  it('grades several detections with one verdict and reports the ones that moved', async () => {
    const fresh = await shadowDetectionRepository.record(detection());
    const moved = await shadowDetectionRepository.record(detection());
    await grade(moved, 0, 'legitimate_human');
    const missing = 'f'.repeat(24);

    const result = await shadowDetectionRepository.addVerdicts({
      items: [
        { id: fresh, expectedRevision: 0 },
        { id: fresh, expectedRevision: 0 },
        { id: moved, expectedRevision: 0 },
        { id: missing, expectedRevision: 0 },
      ],
      verdict: 'confirmed_abuse',
      reason: 'Same cohort',
      reviewerId: 'admin1',
    });

    expect(result.updated.map(item => [item.id, item.verdict])).toEqual([[fresh, 'confirmed_abuse']]);
    expect(result.conflicts.map(item => [item.id, item.verdict])).toEqual([[moved, 'legitimate_human']]);
    expect(result.notFound).toEqual([missing]);
  });
});
