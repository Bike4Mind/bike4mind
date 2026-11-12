import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FeedbackAiModel, FeedbackModel, adminAiSuggestionRepository } from '@bike4mind/database';
import { FEEDBACK_AI_POLICY } from '@bike4mind/common';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Handler = (req: Request, res: Response) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  patch: null as Handler | null,
  get: null as Handler | null,
  visible: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: () => {
    const chain = {
      get: (h: Handler) => {
        mocks.get = h;
        return chain;
      },
      patch: (h: Handler) => {
        mocks.patch = h;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@server/admin/ai/feedbackVisibility', () => ({ feedbackAiVisible: mocks.visible }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: mocks.audit,
  userAuditTarget: async (id: string) => ({ kind: 'user', id }),
}));
await import('../ai');
let mongo: MongoMemoryReplSet;
beforeAll(async () => {
  mongo = await createMongoReplSet();
  await mongoose.connect(mongo.getUri());
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
afterEach(async () => {
  await mongoose.connection.dropDatabase();
  vi.clearAllMocks();
});
const labels = {
  area: 'chat' as const,
  severity: 'major' as const,
  actionable: true,
  needsReply: false,
  duplicateId: null,
};
const setup = async (reportId?: mongoose.Types.ObjectId) => {
  mocks.visible.mockResolvedValue(true);
  mocks.audit.mockResolvedValue({ id: 'audit' });
  const report = await FeedbackModel.create({
    ...(reportId ? { _id: reportId } : {}),
    userId: 'reporter',
    username: 'Reporter',
    status: 'New',
  });
  const suggestion = await adminAiSuggestionRepository.createPending({
    feature: 'feedbackTriage',
    entityType: 'feedback',
    entityId: report.id,
    inputHash: 'hash',
    policyVersion: FEEDBACK_AI_POLICY,
    model: 'decision',
    verdict: 'chat: major',
    confidence: { probability: 0.9, band: 'high' },
    reasons: [],
    proposedAction: labels,
    costUsd: 0,
    latencyMs: 1,
  });
  await FeedbackAiModel.create({
    feedbackId: report.id,
    inputHash: 'hash',
    model: 'embedding',
    vector: [1],
    suggestionId: suggestion.id,
    labels,
    similar: [],
    reportCreatedAt: report.createdAt,
    expiresAt: new Date(Date.now() + 100000),
  });
  return { report, suggestion };
};
const call = async (method: 'GET' | 'PATCH', id: string, body = {}): Promise<unknown> => {
  const { req, res } = createMocks({ method, query: { id }, body });
  Object.assign(req, { user: { id: 'admin', username: 'Admin', isAdmin: true } });
  await (method === 'GET' ? mocks.get! : mocks.patch!)(req as unknown as Request, res as unknown as Response);
  return res._getJSONData();
};
describe('feedback AI manual decisions', () => {
  it('records changed labels as an override and never closes the report', async () => {
    const { report, suggestion } = await setup();
    await call('PATCH', report.id, {
      suggestionId: suggestion.id,
      labels: { ...labels, severity: 'minor' },
      reason: 'Corrected impact',
    });
    expect((await FeedbackAiModel.findOne({ feedbackId: report.id }))?.override?.severity).toBe('minor');
    expect((await adminAiSuggestionRepository.findLatestForEntity('feedbackTriage', report.id))?.status).toBe(
      'overridden'
    );
    expect((await FeedbackModel.findById(report.id))?.status).toBe('New');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: { feedbackId: report.id, aiSuggestionId: suggestion.id } })
    );
  });
  it('rolls back labels and suggestion decision if audit fails', async () => {
    const { report, suggestion } = await setup();
    mocks.audit.mockRejectedValueOnce(new Error('audit failed'));
    await expect(
      call('PATCH', report.id, { suggestionId: suggestion.id, labels, reason: 'Accepted suggestion' })
    ).rejects.toThrow();
    expect((await FeedbackAiModel.findOne({ feedbackId: report.id }))?.override).toBeUndefined();
    expect((await adminAiSuggestionRepository.findLatestForEntity('feedbackTriage', report.id))?.status).toBe(
      'pending'
    );
  });
  it('hides shadow suggestions and refuses writes before readiness', async () => {
    const { report, suggestion } = await setup();
    mocks.visible.mockResolvedValue(false);
    expect(await call('GET', report.id)).toEqual({ suggestion: null, labels: null, similar: [] });
    await expect(
      call('PATCH', report.id, { suggestionId: suggestion.id, labels, reason: 'Accepted suggestion' })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it('uses canonical joins for uppercase report IDs on both reads and decisions', async () => {
    const { report, suggestion } = await setup(new mongoose.Types.ObjectId('abcdefabcdefabcdefabcdef'));
    const uppercase = report.id.toUpperCase();
    expect(await call('GET', uppercase)).toMatchObject({ suggestion: { id: suggestion.id }, labels });
    await call('PATCH', uppercase, { suggestionId: suggestion.id, labels, reason: 'Accepted suggestion' });
    expect((await adminAiSuggestionRepository.findLatestForEntity('feedbackTriage', report.id))?.status).toBe(
      'accepted'
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: { feedbackId: report.id, aiSuggestionId: suggestion.id } })
    );
  });

  it('rejects invalid report IDs before querying report data', async () => {
    const query = vi.spyOn(FeedbackModel, 'exists');
    try {
      await expect(call('GET', 'not-a-report-id')).rejects.toMatchObject({ statusCode: 404 });
      expect(query).not.toHaveBeenCalled();
      expect(mocks.visible).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});
