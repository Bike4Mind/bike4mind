import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260922000000_ensure-data-lake-inconsistency-scan-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const SCAN_INDEX = 'status_1_lastInconsistencyScanAt_1__id_1';

const lake = (overrides: Record<string, unknown> = {}) => ({
  name: 'lake-one',
  slug: 'lake-one',
  fileTagPrefix: 'one:',
  datalakeTag: 'datalake:one',
  createdByUserId: 'migration-test',
  status: 'active',
  ...overrides,
});

const legacySummary = () => ({
  sampled: true,
  truncated: false,
  memberSampled: false,
  memberCount: 3,
  countsByKind: {
    'superlative-conflict': 0,
    'metric-disagreement': 1,
    'relationship-conflict': 0,
    'expired-claim': 0,
  },
});

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle mongoose's own fire-and-forget autoIndex build before any test drops an index, or the
  // background rebuild races the drop and the "not there yet" assertion sees an index the migration
  // never built. Same guard, for the same reason, as the sibling ensure-*-index tests.
  await DataLakeModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created on a
  // fresh mongod, unlike deleteMany.
  await mongoose.connection.db?.createCollection(DataLakeModel.collection.collectionName).catch(() => {});
  await DataLakeModel.collection.deleteMany({});
  await safeDropIndex(DataLakeModel.collection, SCAN_INDEX);
});

const indexNames = async () => (await DataLakeModel.collection.listIndexes().toArray()).map(i => i.name);

describe('ensure data lake inconsistency scan index and strip stored finding excerpts', () => {
  it('builds the index the detection sweep pages on', async () => {
    expect(await indexNames()).not.toContain(SCAN_INDEX);

    await migration.up();

    expect(await indexNames()).toContain(SCAN_INDEX);
  });

  it('is idempotent - a second run over an already-built index is a no-op', async () => {
    await migration.up();
    await migration.up();

    expect((await indexNames()).filter(n => n === SCAN_INDEX)).toHaveLength(1);
  });

  it('strips the findings out of a legacy stored report, excerpts and all', async () => {
    // RETENTION, not tidiness: a stored finding carries a 240-char excerpt of each source document,
    // and the purge-time sweeps that discharge that obligation reach the finding ROWS only. Nothing
    // ever rewrites a blob when a document it quotes is destroyed.
    await DataLakeModel.collection.insertOne({
      ...lake(),
      inconsistencyReport: {
        ...legacySummary(),
        findings: [
          {
            kind: 'metric-disagreement',
            subject: 'annual revenue usd',
            documentCount: 2,
            evidence: [{ fabFileId: 'file-a', fileName: 'a.md', excerpt: 'revenue was 4.2M' }],
          },
        ],
      },
    } as never);

    await migration.up();

    const doc = await DataLakeModel.collection.findOne({ slug: 'lake-one' });
    expect(doc?.inconsistencyReport).not.toHaveProperty('findings');
    // The run-level summary the health surface renders is left exactly as it was.
    expect(doc?.inconsistencyReport).toMatchObject(legacySummary());
  });

  it('leaves a lake that never ran detection alone', async () => {
    await DataLakeModel.collection.insertOne({ ...lake({ slug: 'never-run' }), inconsistencyReport: null } as never);

    await migration.up();

    const doc = await DataLakeModel.collection.findOne({ slug: 'never-run' });
    expect(doc?.inconsistencyReport).toBeNull();
  });

  it('strips every legacy lake, not just the first', async () => {
    const withFindings = (slug: string) => ({
      ...lake({ slug, name: slug, fileTagPrefix: `${slug}:`, datalakeTag: `datalake:${slug}` }),
      inconsistencyReport: { ...legacySummary(), findings: [{ kind: 'expired-claim', subject: slug, evidence: [] }] },
    });
    await DataLakeModel.collection.insertMany([withFindings('multi-a'), withFindings('multi-b')] as never[]);

    await migration.up();

    const docs = await DataLakeModel.collection.find({ slug: { $in: ['multi-a', 'multi-b'] } }).toArray();
    expect(docs).toHaveLength(2);
    for (const doc of docs) expect(doc.inconsistencyReport).not.toHaveProperty('findings');
  });
});
