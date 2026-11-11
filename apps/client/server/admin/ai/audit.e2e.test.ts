import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ADMIN_AI_FEATURES } from '@bike4mind/common';
import { AdminAiSuggestionModel, adminAiSuggestionRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
import {
  ADMIN_AI_SYSTEM_ACTORS,
  adminAiSystemActor,
  readAiSuggestionId,
  recordAiDecision,
  withAiSuggestionId,
} from './audit';

const HEX = '64b7f0c2a1b2c3d4e5f60718';

describe('adminAiSystemActor', () => {
  it.each(ADMIN_AI_FEATURES)('names a platform system actor for %s', feature => {
    expect(adminAiSystemActor(feature)).toEqual({
      kind: 'system',
      scope: 'platform',
      name: `admin-ai:${feature}`,
      wasAdmin: false,
    });
    expect(ADMIN_AI_SYSTEM_ACTORS[feature]).toEqual(adminAiSystemActor(feature));
  });

  it('gives every feature a distinct name', () => {
    const names = new Set(Object.values(ADMIN_AI_SYSTEM_ACTORS).map(actor => actor.name));
    expect(names.size).toBe(ADMIN_AI_FEATURES.length);
  });
});

describe('withAiSuggestionId', () => {
  it('keeps the existing details and adds the id', () => {
    expect(withAiSuggestionId({ reason: 'spam', count: 2 }, HEX)).toEqual({
      reason: 'spam',
      count: 2,
      aiSuggestionId: HEX,
    });
  });
});

describe('readAiSuggestionId', () => {
  it.each([
    ['absent', {}],
    ['explicit undefined', { aiSuggestionId: undefined }],
    ['a non-object body', null],
  ])('is undefined when %s', (_label, body) => {
    expect(readAiSuggestionId(body)).toBeUndefined();
  });

  it('returns a valid id, lowercased', () => {
    expect(readAiSuggestionId({ aiSuggestionId: HEX.toUpperCase() })).toBe(HEX);
  });

  it.each([
    ['empty string', ''],
    ['number', 123],
    ['array', []],
    ['null', null],
    ['short hex', 'abc123'],
    ['non-hex', 'z'.repeat(24)],
  ])('rejects %s as a bad request', (_label, value) => {
    expect(() => readAiSuggestionId({ aiSuggestionId: value })).toThrow(BadRequestError);
  });
});

describe('recordAiDecision', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await AdminAiSuggestionModel.syncIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('decides a pending suggestion once and returns null on a repeat', async () => {
    const pending = await adminAiSuggestionRepository.createPending({
      feature: 'abuseAssessment',
      entityType: 'shadowDetection',
      entityId: 'det-1',
      inputHash: 'h',
      policyVersion: 'v1',
      model: 'm',
      verdict: 'abuse',
      confidence: { band: 'high', probability: 0.9 },
      reasons: [],
      costUsd: 0,
      latencyMs: 1,
    });
    const decidedBy = { userId: HEX, name: 'Admin' };
    const accepted = await recordAiDecision(pending.id, 'accepted', { decidedBy });
    expect(accepted).toMatchObject({ status: 'accepted', decidedBy });
    expect(await recordAiDecision(pending.id, 'overridden')).toBeNull();
    expect(await recordAiDecision('not-an-id', 'accepted')).toBeNull();
  });
});
