/**
 * Real-Mongo check of the verdict eval over seeded rows: a farm an admin suspended and confirmed, the
 * AI rating it legitimate, a genuine look-alike an admin reinstated after a shadow containment
 * decision, and an account banned only by the automation (never a label).
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AbuseAssessmentModel,
  AdminAuditLogModel,
  AutoContainmentDecisionModel,
  ShadowDetectionModel,
  User,
} from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { buildVerdictEvalReport, type VerdictEvalDeps } from './loadVerdictEval';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-06T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await Promise.all(
    [User, ShadowDetectionModel, AbuseAssessmentModel, AutoContainmentDecisionModel, AdminAuditLogModel].map(model =>
      model.collection.deleteMany({})
    )
  );
});

async function seedUser(fields: Record<string, unknown>): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id, username: `user-${_id}`, email: `${_id}@example.test`, ...fields });
  return _id.toString();
}

async function seedDetection(userIds: string[], verdict: string | null): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await ShadowDetectionModel.collection.insertOne({
    _id,
    detector: 'deviceLinkedToBlocked',
    userIds,
    detectedAt: ago(20),
    verdict,
  });
  return _id.toString();
}

const audit = (action: string, userId: string, actorKind: 'user' | 'system', occurredAt: Date) =>
  AdminAuditLogModel.collection.insertOne({
    action,
    actor: { kind: actorKind, scope: 'platform', name: 'seed', wasAdmin: actorKind === 'user' },
    target: { kind: 'user', id: userId, displayName: 'seed' },
    occurredAt,
  });

describe('buildVerdictEvalReport', () => {
  it('grades the seeded verdicts against admin labels and ignores bans the automation made', async () => {
    const farm = await seedUser({ createdAt: ago(22), isBanned: true });
    const lookalike = await seedUser({ createdAt: ago(30), isBanned: false });
    const selfBanned = await seedUser({ createdAt: ago(10), isBanned: true });

    const farmDetection = await seedDetection([farm], 'confirmed_abuse');
    const lookalikeDetection = await seedDetection([lookalike], null);
    const selfDetection = await seedDetection([selfBanned], null);

    await AbuseAssessmentModel.collection.insertMany([
      {
        cacheKey: `seed-${farmDetection}`,
        detectionId: farmDetection,
        result: 'legitimate_automation',
        confidence: 0.7,
        decisionModel: 'jev-latest',
        assessedAt: ago(19),
      },
      {
        cacheKey: `seed-${lookalikeDetection}`,
        detectionId: lookalikeDetection,
        result: 'abuse',
        confidence: 0.8,
        decisionModel: 'jev-latest',
        assessedAt: ago(19),
      },
      {
        cacheKey: `seed-${selfDetection}`,
        detectionId: selfDetection,
        result: 'abuse',
        confidence: 0.9,
        decisionModel: 'jev-latest',
        assessedAt: ago(9),
      },
    ]);
    await AutoContainmentDecisionModel.collection.insertMany(
      [lookalikeDetection, selfDetection].map(detectionId => ({
        detectionId,
        revision: 1,
        outcome: 'contained',
        mode: 'enforce',
        confidence: 0.9,
        decidedAt: ago(18),
      }))
    );
    await audit('user.suspended', farm, 'user', ago(15));
    await audit('user.bulk.contained', lookalike, 'system', ago(18));
    await audit('user.reinstated', lookalike, 'user', ago(5));
    await audit('user.bulk.contained', selfBanned, 'system', ago(8));

    const signupVerdicts = vi.fn<VerdictEvalDeps['signupVerdicts']>(async () => new Map([[farm, 'legit' as const]]));
    const report = await buildVerdictEvalReport(7, { signupVerdicts }, NOW);

    expect(report).toMatchObject({ detections: 3, labelledDetections: 2, truncated: false });
    expect(report.scores).toEqual([
      expect.objectContaining({ grader: 'assessment', variant: 'jev-latest', falseNegative: 1, falsePositive: 1 }),
      expect.objectContaining({ grader: 'containment', variant: 'enforce', falsePositive: 1, truePositive: 0 }),
      expect.objectContaining({ grader: 'signupVerdict', variant: 'chart', falseNegative: 1 }),
    ]);
    expect(report.disagreements.map(row => [row.grader, row.kind, row.labelSource])).toEqual(
      expect.arrayContaining([
        ['assessment', 'falseNegative', 'adminVerdict'],
        ['assessment', 'falsePositive', 'reinstated'],
        ['containment', 'falsePositive', 'reinstated'],
        ['signupVerdict', 'falseNegative', 'adminSuspended'],
      ])
    );
    expect(report.disagreements.some(row => row.detectionId === selfDetection)).toBe(false);
    expect(signupVerdicts).toHaveBeenCalledWith(
      expect.objectContaining({ range: '7d', userIds: expect.arrayContaining([farm, lookalike, selfBanned]) })
    );
  });
});
