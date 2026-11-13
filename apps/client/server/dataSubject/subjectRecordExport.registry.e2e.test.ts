import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mongoose } from '@bike4mind/database';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// Registered outside the `@bike4mind/database` barrel, so they register only when imported.
import '@bike4mind/server-utils/models/Subscription';
import '@server/models/UserSubscription';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SubjectRecordExport, assertEveryModelClassified } from './subjectRecordExport';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer | undefined;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

describe('SubjectRecordExport over the real registry', () => {
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
