import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  accountDeletionNoticeRepository,
  mongoose,
  oauthClientSignInRepository,
  PlatformAttempt,
  platformAttemptRepository,
  UsageEvent,
  usageEventRepository,
} from '@bike4mind/database';
import { CreditHolderType, PlatformUsageEvent, type IPlatformUsageEventInput } from '@bike4mind/common';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { SubjectErasurePlan } from './subjectErasurePlan';
import { SubjectRecordExport, assertEveryModelClassified } from './subjectRecordExport';
import { SubjectErasureExecutor } from './subjectErasureExecutor';
import { DATA_HOLDER_REGISTRY } from './registry';

vi.mock('sst', () => ({ Resource: new Proxy({}, { get: () => ({ value: 'test', name: 'test' }) }) }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryReplSet | undefined;

beforeAll(async () => {
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('SubjectRecordExport over the real registry', () => {
  it('withholds actorless platform accounting from personal exports and preserves it through person erasure', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const at = new Date(Date.now() - 2000);
    const completedAt = new Date(at.getTime() + 1000);
    const providerCallId = new mongoose.Types.ObjectId().toString();
    const attribution = {
      kind: 'platform_operation' as const,
      operation: 'sre_diagnosis' as const,
      environment: 'test' as const,
      logicalJobId: 'platform-job',
      executionId: 'platform-execution',
    };
    const fact: IPlatformUsageEventInput = {
      attribution,
      providerCallId,
      requestId: attribution.executionId,
      provider: 'privacy-test-provider',
      model: 'privacy-test-model',
      feature: 'operations',
      source: 'system',
      keySource: 'platform',
      creditsCharged: 0,
      inputTokens: 0,
      outputTokens: 0,
      providerInputTokens: 1000,
      providerOutputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      settledBasis: 'provider',
      costUsd: 0.002,
      priceSource: 'literal',
      rates: { tierKey: 0, input: 0.000001, output: 0.000002 },
      status: 'ok',
      dispatchedAt: at,
      completedAt,
      usageOccurredAt: at,
      timestampSource: 'dispatch',
      recordedAt: new Date(),
    };
    PlatformUsageEvent.parse({ ...fact, createdAt: new Date(), updatedAt: new Date() });
    await platformAttemptRepository.register({
      attribution,
      providerCallId,
      provider: fact.provider,
      model: fact.model,
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    expect(await platformAttemptRepository.claimDispatch(providerCallId, at)).toBe(true);
    await platformAttemptRepository.stageUsage(providerCallId, fact);
    const platform = await usageEventRepository.recordPlatform(fact);
    const personal = await usageEventRepository.record({
      requestId: `personal-call-${userId}`,
      userId,
      ownerId: userId,
      ownerType: CreditHolderType.User,
      feature: 'chat',
      provider: 'privacy-test-provider',
      model: 'privacy-test-model',
      inputTokens: 10,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      creditsCharged: 1,
      status: 'ok',
    });
    if (!personal) throw new Error('Personal usage was not recorded');
    try {
      assertEveryModelClassified(mongoose.modelNames());
      expect(() => assertEveryModelClassified([...mongoose.modelNames(), 'UnclassifiedPlatformFixture'])).toThrow(
        'UnclassifiedPlatformFixture'
      );
      const exporter = new SubjectRecordExport({ userId, email: null });
      const attempts = [];
      for await (const row of exporter.records('PlatformAttempt')) attempts.push(row);
      expect(attempts).toEqual([]);
      const usage = [];
      for await (const row of exporter.records('UsageEvent')) usage.push(row);
      expect(usage).toHaveLength(1);
      expect(usage[0].requestId).toBe(`personal-call-${userId}`);
      const beforeAttempt = await PlatformAttempt.findOne({ providerCallId }).lean();
      const beforeUsage = await UsageEvent.findById(platform.id).lean();
      await new SubjectErasureExecutor({ userId, email: null }, async () => {}, {
        PlatformAttempt: DATA_HOLDER_REGISTRY.PlatformAttempt,
        UsageEvent: DATA_HOLDER_REGISTRY.UsageEvent,
      }).run();
      expect(await UsageEvent.findById(personal.id).lean()).toBeNull();
      expect(await PlatformAttempt.findOne({ providerCallId }).lean()).toEqual(beforeAttempt);
      expect(await UsageEvent.findById(platform.id).lean()).toEqual(beforeUsage);
      const summary = await usageEventRepository.platformUsageSummary({ days: 1, source: 'system' });
      expect(summary.byModel.find(row => row.model === 'privacy-test-model')?.cogsUsd).toBe(0.002);
    } finally {
      await PlatformAttempt.deleteMany({ providerCallId });
      await UsageEvent.deleteMany({ _id: { $in: [personal.id, platform.id] } });
    }
  });

  it('exports only the subject reservations and retains their accounting and retry bindings on erasure', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const otherUserId = new mongoose.Types.ObjectId().toString();
    const reservations = [userId, otherUserId].map((id, index) => ({
      userId: id,
      requestId: `request-${index}`,
      reserved: 30,
      charged: index === 0 ? 10 : 0,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      state: index === 0 ? 'settled' : 'reserved',
    }));
    const model = mongoose.model('SpokeBudget');
    await model.create({ _id: 'export-client', revision: 2, reservations });
    try {
      const records = [];
      for await (const record of new SubjectRecordExport({ userId, email: null }).records('SpokeBudget')) {
        records.push(record);
      }
      expect(records).toEqual([{ _id: 'export-client', reservations: [reservations[0]] }]);
      expect(JSON.stringify(records)).not.toContain(otherUserId);

      const before = await model.findById('export-client').lean();
      const result = await new SubjectErasureExecutor({ userId, email: null }, async () => {}, {
        SpokeBudget: DATA_HOLDER_REGISTRY.SpokeBudget,
      }).run();
      expect(result).toEqual([expect.objectContaining({ model: 'SpokeBudget', retained: 1, deleted: 0 })]);
      expect(await model.findById('export-client').lean()).toEqual(before);
    } finally {
      await model.deleteOne({ _id: 'export-client' });
    }
  });

  it('withholds the live deletion-notice lease token from the recipient export', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const email = 'notice-export@example.com';
    const idHash = `notice-export-${userId}`;
    const now = new Date();
    await accountDeletionNoticeRepository.record({ idHash, email, now });
    const claimed = await accountDeletionNoticeRepository.claimDue(idHash, now, now);
    expect(claimed?.leaseToken).toEqual(expect.any(String));
    if (!claimed) throw new Error('Notice was not claimed');

    const records: Record<string, unknown>[] = [];
    for await (const record of new SubjectRecordExport({ userId, email }).records('AccountDeletionNotice')) {
      records.push(record);
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ idHash, email, attempts: 0 });
    expect(records[0]).not.toHaveProperty('leaseToken');
    expect(JSON.stringify(records)).not.toContain(claimed.leaseToken);
    expect((await accountDeletionNoticeRepository.find(idHash))?.leaseToken).toBe(claimed.leaseToken);

    const unrelated: Record<string, unknown>[] = [];
    for await (const record of new SubjectRecordExport({ userId, email: 'other-export@example.com' }).records(
      'AccountDeletionNotice'
    )) {
      unrelated.push(record);
    }
    expect(unrelated).toEqual([]);
  });

  it('exports the apps the subject signed in to, and not another user rows', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const other = new mongoose.Types.ObjectId().toString();
    const first = new Date('2026-01-01T00:00:00Z');
    const last = new Date('2026-02-01T00:00:00Z');
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: 'export-app', at: first });
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: 'export-app', at: last });
    await oauthClientSignInRepository.recordSignIn({ userId: other, clientId: 'other-app', at: last });

    const exporter = new SubjectRecordExport({ userId, email: 'signin-export@example.com' });
    expect(exporter.models).toContain('OAuthClientSignIn');
    const records: Record<string, unknown>[] = [];
    for await (const record of exporter.records('OAuthClientSignIn')) records.push(record);
    expect(records).toEqual([
      expect.objectContaining({ userId, clientId: 'export-app', firstSignInAt: first, lastSignInAt: last }),
    ]);
  });

  // `strictQuery: 'throw'` makes any registry path a schema does not declare fail here, and every
  // viaParent child must find its parent already read.
  it('queries every classified model without error', async () => {
    assertEveryModelClassified(mongoose.modelNames());
    const userId = new mongoose.Types.ObjectId().toString();
    const exporter = new SubjectRecordExport({ userId, email: 'subject@example.com' });

    const order = await exporter.walkOrder();
    expect([...order].sort()).toEqual([...exporter.models].sort());

    const failures: string[] = [];
    for (const model of order) {
      try {
        for await (const _record of exporter.records(model)) void _record;
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    expect(exporter.models.length).toBeGreaterThan(50);
    expect(failures).toEqual([]);
  });

  it('checks which personal-scope files an organization keeps once per batch, not once per file', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const personal = new mongoose.Types.ObjectId();
    const company = new mongoose.Types.ObjectId();
    await mongoose.model('Organization').collection.insertMany([
      { _id: personal, name: 'Mine', userId, personal: true },
      { _id: company, name: 'Company', userId: new mongoose.Types.ObjectId().toString(), personal: false },
    ]);
    const files = [
      ...Array.from({ length: 5 }, () => ({ userId, organizationId: personal.toString(), fileName: 'mine.txt' })),
      ...Array.from({ length: 5 }, () => ({ userId, organizationId: company.toString(), fileName: 'company.txt' })),
    ];
    await mongoose.model('FabFile').collection.insertMany(files);
    const Organization = mongoose.model('Organization');
    const exists = vi.spyOn(Organization, 'exists');
    const find = vi.spyOn(Organization, 'find');
    try {
      const records = [];
      for await (const record of new SubjectRecordExport({ userId, email: null }).records('FabFile')) {
        records.push(record);
      }

      expect(records).toHaveLength(10);
      expect(exists).not.toHaveBeenCalled();
      expect(find).toHaveBeenCalledTimes(1);
    } finally {
      exists.mockRestore();
      find.mockRestore();
    }
  });

  it("withholds the other people and the abuse scoring on the subject's own User record", async () => {
    const userId = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await mongoose.model('User').collection.insertOne({
      _id: userId,
      email: 'own-record@example.com',
      password: 'hash',
      referredByUserId: other,
      throttle: { changedBy: other },
      signupLanding: { notebookOwnerId: other },
      signupGrantAssessment: { band: 'review' },
      riskScore: { score: 80 },
      riskSignals: [{ id: 'datacenter' }],
      riskEvidence: { summary: 'x' },
      signupMeta: { ip: '10.0.0.9' },
      userNotes: [{ note: 'checked', userName: 'Admin A' }],
    });
    const exporter = new SubjectRecordExport({ userId: userId.toString(), email: 'own-record@example.com' });

    const records = [];
    for await (const record of exporter.records('User')) records.push(JSON.parse(JSON.stringify(record)));

    expect(records).toEqual([
      {
        _id: userId.toString(),
        email: 'own-record@example.com',
        throttle: {},
        signupLanding: {},
        userNotes: [{ note: 'checked' }],
      },
    ]);
  });

  it('exports only the own reference of each admin on an approval', async () => {
    const requester = new mongoose.Types.ObjectId().toString();
    const approver = new mongoose.Types.ObjectId().toString();
    const { insertedId } = await mongoose.model('AdminApproval').collection.insertOne({
      action: 'user.delete',
      paramsJson: '{"userId":"someone"}',
      summary: 'delete someone',
      requestedBy: { id: requester, name: 'Requester', email: 'requester@example.com', selfIds: [requester] },
      decidedBy: { id: approver, name: 'Approver' },
    });
    const exportFor = async (userId: string, email: string | null) => {
      const records = [];
      for await (const record of new SubjectRecordExport({ userId, email }).records('AdminApproval')) {
        records.push(JSON.parse(JSON.stringify(record)));
      }
      return records;
    };

    expect(await exportFor(requester, 'requester@example.com')).toEqual([
      {
        _id: insertedId.toString(),
        requestedBy: { id: requester, name: 'Requester', email: 'requester@example.com', selfIds: [requester] },
      },
    ]);
    expect(await exportFor(approver, null)).toEqual([
      { _id: insertedId.toString(), decidedBy: { id: approver, name: 'Approver' } },
    ]);
  });

  it('withholds the requesting admin cached in the details of an audit entry about the subject', async () => {
    const subject = new mongoose.Types.ObjectId().toString();
    const admin = new mongoose.Types.ObjectId().toString();
    await mongoose.model('AdminAuditLog').collection.insertOne({
      action: 'user.deleted',
      actor: { kind: 'user', scope: 'platform', userId: admin, email: 'a@example.com', name: 'A', wasAdmin: true },
      target: { kind: 'user', id: subject },
      context: { ip: '10.0.0.1' },
      details: {
        approval: { id: 'ap-1', requestedBy: { id: admin, name: 'A', email: 'a@example.com' } },
        organizationOwnerId: admin,
        credits: 5,
      },
    });

    const records = [];
    for await (const record of new SubjectRecordExport({ userId: subject, email: null }).records('AdminAuditLog')) {
      records.push(JSON.parse(JSON.stringify(record)));
    }

    expect(records).toHaveLength(1);
    expect(records[0].details).toEqual({ approval: { id: 'ap-1' }, credits: 5 });
    expect(records[0].actor).toEqual({ kind: 'user', scope: 'platform', wasAdmin: true });
    expect(records[0]).not.toHaveProperty('context.ip');
  });

  it('exports only their own part of an eval-set example to the flagged user and to each reviewer', async () => {
    const [flagged, other, reviewerA, reviewerB, creator] = Array.from({ length: 5 }, () =>
      new mongoose.Types.ObjectId().toString()
    );
    const detectionId = new mongoose.Types.ObjectId().toString();
    const verdict = (reviewerId: string, reason: string) => ({
      verdict: 'confirmed_abuse',
      reason,
      reviewerId: new mongoose.Types.ObjectId(reviewerId),
      reviewedAt: new Date('2026-11-01T00:00:00Z'),
    });
    const example = (userId: string, verdicts: ReturnType<typeof verdict>[]) => ({
      userId: new mongoose.Types.ObjectId(userId),
      kind: 'flagged',
      detectionIds: [new mongoose.Types.ObjectId(detectionId)],
      campaignKey: 'campaign-hash',
      split: 'test',
      cohorts: [],
      signedUpAt: null,
      frozenLabel: null,
      verdicts,
      revision: 0,
    });
    const { insertedId } = await mongoose.model('AbuseEvalSet').collection.insertOne({
      name: 'eval set',
      note: null,
      createdBy: new mongoose.Types.ObjectId(creator),
      examples: [
        example(flagged, [verdict(reviewerA, 'reason A'), verdict(reviewerB, 'reason B')]),
        example(other, [verdict(reviewerA, 'reason A on other')]),
      ],
      runs: [],
    });
    const exportFor = async (userId: string) => {
      const records = [];
      for await (const record of new SubjectRecordExport({ userId, email: null }).records('AbuseEvalSet')) {
        records.push(JSON.parse(JSON.stringify(record)));
      }
      return records;
    };

    const [flaggedRecord] = await exportFor(flagged);
    expect(flaggedRecord._id).toBe(insertedId.toString());
    expect(flaggedRecord.examples).toEqual([
      expect.objectContaining({ userId: flagged, detectionIds: [detectionId], verdicts: [] }),
    ]);

    const [reviewerRecord] = await exportFor(reviewerA);
    expect(reviewerRecord).toEqual({
      _id: insertedId.toString(),
      examples: [
        { verdicts: [expect.objectContaining({ reviewerId: reviewerA, reason: 'reason A' })] },
        { verdicts: [expect.objectContaining({ reviewerId: reviewerA, reason: 'reason A on other' })] },
      ],
    });
    expect(JSON.stringify(reviewerRecord)).not.toContain(reviewerB);
  });

  it('exports one entry for an eval-set example whose owner also reviewed it', async () => {
    const [both, reviewerB, creator] = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId().toString());
    const verdict = (reviewerId: string, reason: string) => ({
      verdict: 'confirmed_abuse',
      reason,
      reviewerId: new mongoose.Types.ObjectId(reviewerId),
      reviewedAt: new Date('2026-11-01T00:00:00Z'),
    });
    await mongoose.model('AbuseEvalSet').collection.insertOne({
      name: 'eval set',
      note: null,
      createdBy: new mongoose.Types.ObjectId(creator),
      examples: [
        {
          userId: new mongoose.Types.ObjectId(both),
          kind: 'flagged',
          detectionIds: [],
          campaignKey: 'campaign-hash',
          split: 'test',
          cohorts: [],
          signedUpAt: null,
          frozenLabel: null,
          verdicts: [verdict(both, 'own reason'), verdict(reviewerB, 'reason B')],
          revision: 0,
        },
      ],
      runs: [],
    });
    const records = [];
    for await (const record of new SubjectRecordExport({ userId: both, email: null }).records('AbuseEvalSet')) {
      records.push(JSON.parse(JSON.stringify(record)));
    }

    expect(records).toHaveLength(1);
    expect(records[0].examples).toHaveLength(1);
    expect(records[0].examples[0]).toEqual(
      expect.objectContaining({ userId: both, verdicts: [expect.objectContaining({ reviewerId: both })] })
    );
    expect(JSON.stringify(records[0])).not.toContain(reviewerB);
    expect(JSON.stringify(records[0])).not.toContain('reason B');
  });
});

describe('SubjectErasurePlan over the real registry', () => {
  it('walks every classified model without error', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    await expect(new SubjectErasurePlan({ userId, email: 'subject@example.com' }).collections()).resolves.toEqual([]);
  });

  it('lists the apps the subject signed in to for deletion, counting only their rows', async () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const at = new Date();
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: 'plan-app-a', at });
    await oauthClientSignInRepository.recordSignIn({ userId, clientId: 'plan-app-b', at });
    await oauthClientSignInRepository.recordSignIn({ userId: 'someone-else', clientId: 'plan-app-a', at });

    const collections = await new SubjectErasurePlan({ userId, email: 'plan@example.com' }).collections();
    expect(collections.find(({ model }) => model === 'OAuthClientSignIn')).toMatchObject({
      deleted: 2,
      anonymized: 0,
      retained: 0,
    });
  });
});
