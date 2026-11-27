import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose, { type Model } from 'mongoose';
import { createMongoServer } from '../../../__test__/createMongoServer';
import {
  StatusBreakGlassQuarantine,
  StatusComponent,
  StatusComponentInterval,
  StatusDailyRollup,
  StatusExternalTransition,
  StatusHistoryCorrection,
  StatusIncident,
  StatusOverride,
  StatusProbeResult,
  StatusProbeState,
  StatusRunState,
  StatusSnapshot,
} from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = Model<any>;

let server: Awaited<ReturnType<typeof createMongoServer>>;

// Same set the status-page-indexes migration builds.
const unique: [string, AnyModel, Record<string, 1 | -1>, () => Record<string, unknown>][] = [
  [
    'statusComponents key',
    StatusComponent,
    { key: 1 },
    () => ({
      key: 'api',
      publicSlug: 'api-one',
      source: 'core',
      name: 'API',
      group: 'core',
      order: 1,
      visibility: 'public',
      monitoring: 'probed',
      externallyMonitored: false,
    }),
  ],
  [
    'statusComponents publicSlug',
    StatusComponent,
    { publicSlug: 1 },
    () => ({
      key: `other-${new mongoose.Types.ObjectId()}`,
      publicSlug: 'api-one',
      source: 'core',
      name: 'API',
      group: 'core',
      order: 1,
      visibility: 'public',
      monitoring: 'probed',
      externallyMonitored: false,
    }),
  ],
  [
    'statusProbeStates probeKey',
    StatusProbeState,
    { probeKey: 1 },
    () => ({
      probeKey: 'app.health',
      componentKey: 'api',
      state: 'operational',
      lastResultAt: new Date(),
      lastRunScheduledAt: new Date(),
      lastChangeAt: new Date(),
    }),
  ],
  [
    'statusIncidents publicId',
    StatusIncident,
    { publicId: 1 },
    () => ({
      publicId: 'abcdefghij',
      kind: 'incident',
      source: 'admin',
      title: 'Elevated errors',
      status: 'investigating',
      impact: 'minor',
      startedAt: new Date(),
      createdBy: 'admin-1',
    }),
  ],
  [
    'statusExternalTransitions sourceKey',
    StatusExternalTransition,
    { sourceKey: 1 },
    () => ({ at: new Date(), state: 'up', sourceKey: 'probe/2026-01-01T00:00:00Z', expiresAt: new Date() }),
  ],
  [
    'statusDailyRollups componentKey+day',
    StatusDailyRollup,
    { componentKey: 1, day: 1 },
    () => ({
      componentKey: 'api',
      day: '2026-01-01',
      observedSeconds: 86400,
      downtimeSeconds: 0,
      uptime: 1,
      barState: 'o',
      computedAt: new Date(),
      expiresAt: new Date(),
    }),
  ],
  [
    'statusSnapshots key',
    StatusSnapshot,
    { key: 1 },
    () => ({
      kind: 'summary',
      key: 'summary.json',
      body: '{}',
      etag: 'e1',
      seq: 1,
      generatedAt: new Date(),
      probesAsOf: new Date(),
    }),
  ],
];

const ttl: [string, AnyModel][] = [
  ['statusProbeResults', StatusProbeResult],
  ['statusComponentIntervals', StatusComponentInterval],
  ['statusExternalTransitions', StatusExternalTransition],
  ['statusDailyRollups', StatusDailyRollup],
];

const allModels: AnyModel[] = [
  StatusComponent,
  StatusProbeResult,
  StatusProbeState,
  StatusComponentInterval,
  StatusOverride,
  StatusHistoryCorrection,
  StatusIncident,
  StatusBreakGlassQuarantine,
  StatusExternalTransition,
  StatusDailyRollup,
  StatusSnapshot,
  StatusRunState,
];

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Promise.all(allModels.map(model => model.createCollection()));
  await Promise.all(allModels.map(model => model.createIndexes()));
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Promise.all(allModels.map(model => model.deleteMany({})));
});

describe('status page unique indexes', () => {
  it.each(unique)('%s rejects a duplicate', async (_label, model, _key, make) => {
    await model.collection.insertOne(make());
    await expect(model.collection.insertOne(make())).rejects.toMatchObject({ code: 11000 });
  });

  it.each(unique)('%s is a plain unique index', async (_label, model, key) => {
    const indexes = await model.collection.indexes();
    const found = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
    expect(found).toMatchObject({ unique: true });
    expect(found).not.toHaveProperty('sparse');
    expect(found).not.toHaveProperty('partialFilterExpression');
  });

  it('declares no unique index beyond the ones above, and none sparse', () => {
    const declared = allModels.flatMap(model =>
      model.schema
        .indexes()
        .flatMap(([fields, options]) => (options?.unique ? [[model.modelName, fields, options]] : []))
    );
    expect(declared).toHaveLength(
      new Set(unique.map(([, model, key]) => `${model.modelName}${JSON.stringify(key)}`)).size
    );
    for (const [, , options] of declared) expect(options).not.toHaveProperty('sparse');
    for (const model of allModels) {
      for (const [, options] of model.schema.indexes()) expect(options).not.toHaveProperty('sparse');
    }
  });
});

describe('declared indexes', () => {
  it('builds every index each schema declares, with the same key spec', async () => {
    for (const model of allModels) {
      const built = (await model.collection.indexes()).map(index => JSON.stringify(index.key));
      for (const [fields] of model.schema.indexes()) {
        expect(built, model.modelName).toContain(JSON.stringify(fields));
      }
    }
  });
});

describe('status page TTL indexes', () => {
  it.each(ttl)('%s expires rows at expiresAt', async (_label, model) => {
    const indexes = await model.collection.indexes();
    expect(indexes.find(index => JSON.stringify(index.key) === '{"expiresAt":1}')).toMatchObject({
      expireAfterSeconds: 0,
    });
  });

  it('puts a TTL index only on the collections that expire', async () => {
    const expiring = new Set<string>(ttl.map(([, model]) => model.modelName));
    for (const model of allModels) {
      const indexes = await model.collection.indexes();
      const hasTtl = indexes.some(index => index.expireAfterSeconds !== undefined);
      expect(hasTtl).toBe(expiring.has(model.modelName));
    }
  });
});
