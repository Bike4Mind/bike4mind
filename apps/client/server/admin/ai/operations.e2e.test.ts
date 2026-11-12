import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  AdminAiAttemptModel,
  AdminAiClassModel,
  AdminAiSuggestionModel,
  AdminAuditLogModel,
  AdminSettings,
  adminAiSuggestionRepository,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { getAdminAiOperations } from './operations';
import { getAdminAiClassReadiness, validateAdminAiConfigPromotion } from './readiness';
import { AdminAiConfigSchema } from '@bike4mind/common';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: MongoMemoryReplSet;
const now = new Date('2026-06-20T12:00:00Z');
const key = { feature: 'feedbackTriage' as const, actionClass: 'labels', policyVersion: 'v1' };
beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await AdminAiClassModel.syncIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await Promise.all((await mongoose.connection.db!.collections()).map(c => c.deleteMany({})));
});
async function suggestion(status: 'accepted' | 'overridden', date: Date, id: string) {
  const row = await adminAiSuggestionRepository.createPending({
    ...key,
    entityType: 'feedback',
    entityId: id,
    inputHash: id,
    model: 'test',
    verdict: 'bug',
    confidence: { band: 'high', probability: 0.9 },
    reasons: [],
    costUsd: 0.02,
    latencyMs: 1,
  });
  await AdminAiSuggestionModel.updateOne({ _id: row.id }, { $set: { status, decidedAt: date, overrideCostly: false } });
  return row;
}
describe('durable AI operations', () => {
  it('derives spend from suggestions and failed attempts without counting cached historical records twice', async () => {
    const legacy = await suggestion('accepted', now, 'old');
    await AdminAiSuggestionModel.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(legacy.id) },
      { $set: { createdAt: now } }
    );
    await AdminAiAttemptModel.create({
      feature: key.feature,
      policyVersion: 'v1',
      outcome: 'cached',
      suggestionId: legacy.id,
      calls: 0,
      knownCostUsd: 0,
      costUnknown: false,
      startedAt: now,
      finishedAt: now,
    });
    await AdminAiAttemptModel.create({
      feature: key.feature,
      policyVersion: 'v1',
      outcome: 'skip',
      skipReason: 'provider_down',
      calls: 1,
      knownCostUsd: 0.03,
      costUnknown: true,
      startedAt: now,
      finishedAt: now,
    });
    await AdminSettings.create({ settingName: 'adminAiConfig', settingValue: { monthlyCapUsd: 0.06 } });
    const data = await getAdminAiOperations(now);
    expect(data.features.find(f => f.feature === key.feature)).toMatchObject({
      todayUsd: 0.05,
      monthUsd: 0.05,
      callsToday: 1,
      unknownCostAttempts: 1,
      accepted7: 1,
      overridden7: 0,
      skips: [{ reason: 'provider_down', count: 1 }],
    });
    expect(data.budgetState).toBe('warning');
    expect(data.coverage).toContain('unavailable');
  });
  it('demotes a class once per new decision evidence and writes the named system audit', async () => {
    await AdminAiClassModel.create({ ...key, mode: 'act' });
    await suggestion('overridden', new Date(now.getTime() - 1000), 'a');
    expect((await getAdminAiClassReadiness(key, now)).mode).toBe('recommend');
    expect((await getAdminAiClassReadiness(key, now)).mode).toBe('recommend');
    await suggestion('overridden', now, 'b');
    expect((await getAdminAiClassReadiness(key, now)).mode).toBe('shadow');
    const logs = await AdminAuditLogModel.find({ summary: 'automatically demoted admin AI class' }).lean();
    expect(logs).toHaveLength(2);
    expect(logs[0].actor.name).toBe('admin-ai:feedbackTriage');
  });
  it('fails closed without class evidence or a registered reversible action', async () => {
    expect(await getAdminAiClassReadiness(key, now)).toMatchObject({ canAct: false, canRecommend: false });
    const config = AdminAiConfigSchema.parse({ enabled: true, features: { feedbackTriage: { mode: 'act' } } });
    await expect(validateAdminAiConfigPromotion(config)).rejects.toThrow(/evidence/);
    await AdminAiClassModel.create({
      ...key,
      mode: 'shadow',
      replayCases: 200,
      replayAgreed: 180,
      replayArtifact: 'v1',
    });
    await expect(validateAdminAiConfigPromotion(config)).rejects.toThrow(/handler/);
  });
  it('always permits the global kill switch even if existing evidence is insufficient', async () => {
    await expect(
      validateAdminAiConfigPromotion(
        AdminAiConfigSchema.parse({ enabled: false, features: { feedbackTriage: { mode: 'act' } } })
      )
    ).resolves.toBeUndefined();
  });
  it('honors global and feature switches in the readiness API itself', async () => {
    await AdminAiClassModel.create({
      ...key,
      mode: 'recommend',
      replayCases: 200,
      replayAgreed: 180,
      replayArtifact: 'v1',
    });
    expect((await getAdminAiClassReadiness(key, now)).canRecommend).toBe(false);
    await AdminSettings.create({
      settingName: 'adminAiConfig',
      settingValue: { enabled: true, features: { feedbackTriage: { mode: 'recommend' } } },
    });
    expect((await getAdminAiClassReadiness(key, now)).canRecommend).toBe(true);
    await AdminSettings.updateOne({ settingName: 'adminAiConfig' }, { $set: { 'settingValue.enabled': false } });
    expect((await getAdminAiClassReadiness(key, now)).canRecommend).toBe(false);
    await AdminSettings.updateOne(
      { settingName: 'adminAiConfig' },
      { $set: { 'settingValue.enabled': true, 'settingValue.features.feedbackTriage.mode': 'shadow' } }
    );
    expect((await getAdminAiClassReadiness(key, now)).canRecommend).toBe(false);
  });
});
