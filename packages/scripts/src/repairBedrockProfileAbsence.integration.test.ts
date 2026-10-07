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

/**
 * A seed row: the tier that owns `lifecycle` once the repair stops claiming it.
 * Its identity/limits values differ from the graduation row's, so the retention
 * assertion below can tell the repair row's values from seed's.
 */
const seedRow = (modelId: string, lifecycle: ModelRecord['lifecycle']): IModelCatalogRowInput => ({
  modelId,
  source: 'seed',
  patch: { ...bedrockRecord(modelId, lifecycle), name: `seed ${modelId}`, contextWindow: 100_000 },
  ownedGroups: ['identity', 'limits', 'dispatch', 'lifecycle'],
  effectiveFrom: new Date('2026-07-01T00:00:00Z'),
});

const seed = async () => {
  // The seed belief the repair cedes lifecycle back to: active, undated.
  await modelCatalogRepository.append(seedRow('global.anthropic.claude-sonnet-4-6', { status: 'active' }));
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

const lifecycleOf = (rows: Awaited<ReturnType<typeof modelCatalogRepository.rowsInForce>>, modelId: string) =>
  resolveCatalogRecords(rows).get(modelId)?.record.lifecycle as
    { status?: string; deprecationDate?: string } | undefined;

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
    // Active AND undated, or isModelDeprecated would still hide it from /api/models.
    expect(lifecycleOf(rows, 'global.anthropic.claude-sonnet-4-6')).toMatchObject({ status: 'active' });
    expect(lifecycleOf(rows, 'global.anthropic.claude-sonnet-4-6')?.deprecationDate).toBeUndefined();
    // The repair row still owns the graduation row's non-lifecycle groups, so
    // identity/limits/dispatch keep the graduation values instead of falling
    // back to seed's (contextWindow 200_000 here, 100_000 on the seed row).
    const repaired = resolveCatalogRecords(rows).get('global.anthropic.claude-sonnet-4-6');
    expect(repaired?.ownedGroups).toEqual(expect.arrayContaining(['identity', 'limits', 'dispatch', 'lifecycle']));
    expect(repaired?.record.contextWindow).toBe(200_000);
    // Selective: the bare graduated id and the operator row keep their status.
    expect(lifecycleOf(rows, 'anthropic.claude-3-haiku-20240307-v1:0')?.status).toBe('deprecated');
    expect(lifecycleOf(rows, 'us.anthropic.claude-opus-4-1-20250805-v1:0')?.status).toBe('deprecated');

    // The stale streak is cleared, so the next discovery run starts from zero.
    const state = await ModelDiscoveryState.findOne({ modelId: 'global.anthropic.claude-sonnet-4-6' }).lean();
    expect(state?.missCount).toBe(0);
    expect(state?.firstMissAt ?? null).toBeNull();

    const rowsAfterFirst = await ModelCatalog.countDocuments({});
    const second = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(second.repaired).toBe(0);
    expect(await ModelCatalog.countDocuments({})).toBe(rowsAfterFirst);
  });

  it('leaves a profile id seed already deprecates deprecated', async () => {
    const modelId = 'us.anthropic.claude-3-5-haiku-20241022-v1:0';
    await modelCatalogRepository.append(seedRow(modelId, { status: 'deprecated', deprecationDate: '2026-02-19' }));
    await modelCatalogRepository.append(graduated(modelId));

    const result = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(result.candidates.map(candidate => candidate.modelId)).toEqual([modelId]);

    const rows = await modelCatalogRepository.rowsInForce(new Date());
    expect(lifecycleOf(rows, modelId)).toMatchObject({ status: 'deprecated', deprecationDate: '2026-02-19' });
  });

  /** A later discovery write (e.g. an aggregator enrichment) restating every group it inherited. */
  const restated = (modelId: string, lifecycle: ModelRecord['lifecycle']): IModelCatalogRowInput => ({
    ...graduated(modelId),
    patch: { ...bedrockRecord(modelId, lifecycle), contextWindow: 1_000_000 },
    effectiveFrom: new Date('2026-09-02T00:00:00Z'),
    note: 'discovery:models.dev@2026-09-02T00:00:00.000Z',
  });

  it('repairs a graduation a later discovery row carried forward unchanged', async () => {
    const modelId = 'global.anthropic.claude-sonnet-5';
    await modelCatalogRepository.append(seedRow(modelId, { status: 'active' }));
    await modelCatalogRepository.append(graduated(modelId));
    await modelCatalogRepository.append(restated(modelId, { status: 'deprecated', deprecationDate: '2026-08-01' }));

    const result = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(result.candidates).toEqual([
      { modelId, foundationId: 'anthropic.claude-sonnet-5', graduatedAt: '2026-08-01T00:00:00.000Z' },
    ]);

    const rows = await modelCatalogRepository.rowsInForce(new Date());
    expect(lifecycleOf(rows, modelId)).toMatchObject({ status: 'active' });
    expect(lifecycleOf(rows, modelId)?.deprecationDate).toBeUndefined();
    // The enrichment the carrying row brought is kept, not reverted to the graduation's.
    expect(resolveCatalogRecords(rows).get(modelId)?.record.contextWindow).toBe(1_000_000);

    expect((await repairBedrockProfileAbsence({ apply: true, log: silent })).repaired).toBe(0);
  });

  it('leaves a profile id a later discovery row deprecated for its own reason', async () => {
    const modelId = 'global.anthropic.claude-sonnet-5';
    await modelCatalogRepository.append(seedRow(modelId, { status: 'active' }));
    await modelCatalogRepository.append(graduated(modelId));
    await modelCatalogRepository.append(restated(modelId, { status: 'deprecated', deprecationDate: '2026-09-15' }));

    const result = await repairBedrockProfileAbsence({ apply: true, log: silent });
    expect(result.candidates).toEqual([]);

    const rows = await modelCatalogRepository.rowsInForce(new Date());
    expect(lifecycleOf(rows, modelId)).toMatchObject({ status: 'deprecated', deprecationDate: '2026-09-15' });
  });
});
