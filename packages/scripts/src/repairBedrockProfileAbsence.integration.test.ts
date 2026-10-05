import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { ModelBackend, type IModelCatalogRowInput, type ModelRecord } from '@bike4mind/common';
import {
  ModelCatalog,
  ModelDiscoveryState,
  modelCatalogRepository,
  modelDiscoveryStateRepository,
} from '@bike4mind/database';
import { resolveCatalogRecords } from '@bike4mind/llm-adapters';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';

vi.mock('../utils/config', () => ({ Config: {} }));

import { repairBedrockProfileAbsence } from './repairBedrockProfileAbsence';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await ModelCatalog.collection.deleteMany({});
  await ModelDiscoveryState.collection.deleteMany({});
});

const AT = new Date('2026-09-01T00:00:00Z');
const silent = () => undefined;

const bedrockRecord = (id: string, lifecycle: ModelRecord['lifecycle']): ModelRecord => ({
  id,
  vendor: 'anthropic',
  backend: ModelBackend.Bedrock,
  type: 'text',
  name: id,
  contextWindow: 200_000,
  adapterFamily: 'bedrock-anthropic',
  dispatchProfile: { maxTokensParam: 'max_tokens', toolTransport: 'native' },
  lifecycle,
});

/** A discovery row the absence protocol wrote: deprecated, stamped with its prefix. */
const graduated = (modelId: string): IModelCatalogRowInput => ({
  modelId,
  source: 'discovery',
  patch: bedrockRecord(modelId, { status: 'deprecated', deprecationDate: '2026-08-01' }),
  ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
  effectiveFrom: AT,
  note: 'discovery:absence@2026-08-01T00:00:00.000Z',
});

const seed = async () => {
  await modelCatalogRepository.append(graduated('global.anthropic.claude-sonnet-4-6'));
  // A bare Bedrock id graduated by absence: real, but not a profile id.
  await modelCatalogRepository.append(graduated('anthropic.claude-3-haiku-20240307-v1:0'));
  // An operator who deprecated a profile id for their own reason: never touched.
  await modelCatalogRepository.append({
    modelId: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    source: 'operator',
    patch: { lifecycle: { status: 'deprecated', deprecationDate: '2026-08-01' } },
    ownedGroups: ['lifecycle'],
    note: 'pinned deprecated by an operator',
    effectiveFrom: AT,
  } as IModelCatalogRowInput);
  // A stale miss streak, so the reset is observable.
  await modelDiscoveryStateRepository.recordMiss(
    'global.anthropic.claude-sonnet-4-6',
    new Date('2026-07-30T00:00:00Z')
  );
  await modelDiscoveryStateRepository.recordMiss(
    'global.anthropic.claude-sonnet-4-6',
    new Date('2026-07-31T00:00:00Z')
  );
};

const statusOf = (rows: Awaited<ReturnType<typeof modelCatalogRepository.rowsInForce>>, modelId: string) =>
  (resolveCatalogRecords(rows).get(modelId)?.record.lifecycle as { status?: string } | undefined)?.status;

describe('repairBedrockProfileAbsence', () => {
  it('reports the affected profile id without writing in a dry run', async () => {
    await seed();
    const before = await ModelCatalog.countDocuments({});

    const result = await repairBedrockProfileAbsence({ log: silent });

    expect(result.repaired).toBe(1);
    expect(result.candidates.map(candidate => candidate.modelId)).toEqual(['global.anthropic.claude-sonnet-4-6']);
    expect(await ModelCatalog.countDocuments({})).toBe(before);
  });

  it('repairs only the absence-graduated profile id, and a second apply is a no-op', async () => {
    await seed();

    const first = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(first.repaired).toBe(1);

    const rows = await modelCatalogRepository.rowsInForce(new Date());
    expect(statusOf(rows, 'global.anthropic.claude-sonnet-4-6')).toBe('active');
    // Selective: the bare graduated id and the operator row keep their status.
    expect(statusOf(rows, 'anthropic.claude-3-haiku-20240307-v1:0')).toBe('deprecated');
    expect(statusOf(rows, 'us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe('deprecated');

    // The stale streak is cleared, so the next discovery run starts from zero.
    const state = await ModelDiscoveryState.findOne({ modelId: 'global.anthropic.claude-sonnet-4-6' }).lean();
    expect(state?.missCount).toBe(0);
    expect(state?.firstMissAt ?? null).toBeNull();

    const rowsAfterFirst = await ModelCatalog.countDocuments({});
    const second = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(second.repaired).toBe(0);
    expect(await ModelCatalog.countDocuments({})).toBe(rowsAfterFirst);
  });
});
