import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose, { Schema, type mongo } from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { mongoose as databaseMongoose } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import { stringifySnapshot } from './canonicalJson';
import { compareSnapshots, formatComparison, withinTolerance } from './compareSnapshots';
import { isReadOnlyCommand, READ_ONLY_COMMANDS, recordCommands } from './readOnlyGuard';
import { collectDeclaredIndexes, type ModelLike } from './schemaDrift';
import { SnapshotSchema, type Snapshot } from './snapshotSchema';
import { findInvalidTtlIndexes, takeSnapshot, type SnapshotOptions } from './takeSnapshot';
import { holdsUndefined } from './undefinedScan';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { MongoClient } = mongoose.mongo;
const TOLERANCE = { absolute: 0, percent: 0 };
const BASE_OPTIONS: SnapshotOptions = {
  exactCounts: true,
  declaredIndexes: null,
  undefinedScan: 'off',
  scanTimeLimitMs: 10_000,
};

let server: MongoMemoryServer;
let writer: mongo.MongoClient;
let reader: mongo.MongoClient;
let databaseCounter = 0;

const freshDatabase = (): { seed: mongo.Db; read: mongo.Db } => {
  databaseCounter += 1;
  const name = `dbstate_${databaseCounter}`;
  return { seed: writer.db(name), read: reader.db(name) };
};

const snapshotAt = (db: mongo.Db, iso: string, options: Partial<SnapshotOptions> = {}): Promise<Snapshot> =>
  takeSnapshot(db, { ...BASE_OPTIONS, ...options, now: () => new Date(iso) });

const seedRepresentativeCollections = async (db: mongo.Db): Promise<void> => {
  const users = db.collection('users');
  await users.insertMany([
    { email: 'a@example.com', org: 1, createdAt: new Date('2026-01-01T00:00:00Z'), bio: 'first' },
    { email: 'b@example.com', org: 2, createdAt: new Date('2026-01-02T00:00:00Z'), bio: 'second' },
  ]);
  await users.createIndex({ email: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
  await users.createIndex({ org: 1, createdAt: -1 }, { partialFilterExpression: { org: { $gt: 0 } } });
  await users.createIndex({ bio: 'text' }, { weights: { bio: 3 } });
  await db.collection('sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
  await db.collection('sessions').insertOne({ createdAt: new Date('2026-01-03T00:00:00Z') });
  await db.createCollection('activeusers', { viewOn: 'users', pipeline: [{ $match: { org: 1 } }] });
};

beforeAll(async () => {
  server = await createMongoServer();
  writer = await new MongoClient(server.getUri()).connect();
  reader = await new MongoClient(server.getUri(), { monitorCommands: true }).connect();
});

afterAll(async () => {
  await reader?.close();
  await writer?.close();
  await server?.stop();
});

describe('snapshot', () => {
  it('is byte-identical apart from the timestamp, and compares empty, on an unchanged database', async () => {
    const { seed, read } = freshDatabase();
    await seedRepresentativeCollections(seed);

    const first = await snapshotAt(read, '2026-01-01T00:00:00.000Z');
    const second = await snapshotAt(read, '2026-01-02T00:00:00.000Z');

    const withoutTimestamp = (snapshot: Snapshot) => stringifySnapshot({ ...snapshot, takenAt: '' });
    expect(withoutTimestamp(second)).toBe(withoutTimestamp(first));
    expect(compareSnapshots(first, second, TOLERANCE).differences).toEqual([]);
    expect(SnapshotSchema.parse(JSON.parse(stringifySnapshot(first)))).toEqual(JSON.parse(stringifySnapshot(first)));
  });

  it('records index options, counts, views and the search index listing', async () => {
    const { seed, read } = freshDatabase();
    await seedRepresentativeCollections(seed);

    const snapshot = await snapshotAt(read, '2026-01-01T00:00:00.000Z');
    const users = snapshot.collections.find(c => c.name === 'users')!;
    const email = users.indexes.find(index => index.name === 'email_1')!;
    const text = users.indexes.find(index => index.name === 'bio_text')!;
    const view = snapshot.collections.find(c => c.name === 'activeusers')!;

    expect(snapshot.collections.map(c => c.name)).toEqual(['activeusers', 'sessions', 'users']);
    expect(users).toMatchObject({ estimatedCount: 2, exactCount: 2 });
    expect(email.options).toMatchObject({
      unique: true,
      collation: { locale: 'en', strength: 2, version: expect.any(String) },
    });
    expect(text.key).toEqual([
      ['_fts', 'text'],
      ['_ftsx', 1],
    ]);
    expect(text.options).toMatchObject({ weights: { bio: 3 }, textIndexVersion: expect.any(Number) });
    expect(view).toMatchObject({ type: 'view', estimatedCount: null, indexes: [] });
    expect(users.searchIndexes).toEqual({ supported: false, reason: expect.any(String) });
    expect(snapshot.server.version).toMatch(/^\d+\.\d+/);
  });
});

describe('compare', () => {
  it('reports a dropped index, an added collection and a changed TTL', async () => {
    const { seed, read } = freshDatabase();
    await seedRepresentativeCollections(seed);
    const before = await snapshotAt(read, '2026-01-01T00:00:00.000Z');

    await seed.collection('users').dropIndex('org_1_createdAt_-1');
    await seed.createCollection('auditlogs');
    await seed.command({ collMod: 'sessions', index: { keyPattern: { createdAt: 1 }, expireAfterSeconds: 7200 } });
    const after = await snapshotAt(read, '2026-01-02T00:00:00.000Z');

    const { differences } = compareSnapshots(before, after, TOLERANCE);
    expect(differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'removed', subject: 'index users.org_1_createdAt_-1' }),
        expect.objectContaining({ kind: 'added', subject: 'collection auditlogs' }),
        expect.objectContaining({
          kind: 'changed',
          subject: 'index sessions.createdAt_1',
          detail: 'expireAfterSeconds: 3600 -> 7200',
        }),
      ])
    );
    expect(differences).toHaveLength(3);
    expect(formatComparison(before, after, compareSnapshots(before, after, TOLERANCE))).toContain(
      '~ index sessions.createdAt_1: expireAfterSeconds: 3600 -> 7200'
    );
  });

  it('applies the count tolerance', async () => {
    const { seed, read } = freshDatabase();
    await seedRepresentativeCollections(seed);
    const before = await snapshotAt(read, '2026-01-01T00:00:00.000Z');
    await seed.collection('users').insertOne({ email: 'c@example.com', org: 3 });
    const after = await snapshotAt(read, '2026-01-02T00:00:00.000Z');

    expect(compareSnapshots(before, after, TOLERANCE).differences.map(d => d.subject)).toEqual([
      'estimated count users',
      'exact count users',
    ]);
    expect(compareSnapshots(before, after, { absolute: 1, percent: 0 }).differences).toEqual([]);
    expect(compareSnapshots(before, after, { absolute: 0, percent: 50 }).differences).toEqual([]);
    expect(withinTolerance(100, 102, { absolute: 0, percent: 1 })).toBe(false);
  });
});

describe('TTL check', () => {
  it('flags expireAfterSeconds values that are not a finite number between 0 and 2147483647', () => {
    const indexes = [NaN, -1, 2147483648, Infinity, '60', 0, 2147483647, 3600].map((value, position) => ({
      name: `ttl_${position}`,
      key: { createdAt: 1 },
      expireAfterSeconds: value,
    }));
    const findings = findInvalidTtlIndexes([
      { name: 'sessions', indexes: [...indexes, { name: 'plain', key: { a: 1 } }] },
    ]);

    expect(findings.map(f => f.index)).toEqual(['ttl_0', 'ttl_1', 'ttl_2', 'ttl_3', 'ttl_4']);
    expect(findings[0].expireAfterSeconds).toEqual({ $numberDouble: 'NaN' });
  });
});

describe('schema drift', () => {
  const schema = new Schema({
    email: { type: String, unique: true },
    createdAt: { type: Date, expires: 3600 },
    org: Number,
  });
  schema.index({ org: 1, createdAt: -1 });
  schema.index({ email: 'text' });
  const model: ModelLike = { modelName: 'DriftThing', collection: { collectionName: 'driftthings' }, schema };

  it('reports declared indexes missing in the database, undeclared ones, and differing options', async () => {
    const { seed, read } = freshDatabase();
    const things = seed.collection('driftthings');
    await things.createIndex({ email: 1 }, { unique: true });
    await things.createIndex({ email: 'text' });
    await things.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 });
    await things.createIndex({ legacy: 1 });
    await seed.collection('unmodeled').insertOne({ a: 1 });

    const snapshot = await snapshotAt(read, '2026-01-01T00:00:00.000Z', {
      declaredIndexes: collectDeclaredIndexes([model]),
    });
    const drift = snapshot.checks.schemaDrift!;

    expect(drift.missingInDatabase).toEqual([
      {
        collection: 'driftthings',
        models: ['DriftThing'],
        key: [
          ['org', 1],
          ['createdAt', -1],
        ],
        options: {},
      },
    ]);
    expect(drift.missingInSchema).toEqual([
      { collection: 'driftthings', index: 'legacy_1', key: [['legacy', 1]], options: {} },
    ]);
    expect(drift.optionMismatches).toEqual([
      {
        collection: 'driftthings',
        index: 'createdAt_1',
        models: ['DriftThing'],
        declared: { expireAfterSeconds: 3600 },
        actual: { expireAfterSeconds: 60 },
      },
    ]);
    expect(drift.unmodeledCollections).toEqual(['unmodeled']);
  });

  it('reads the declared indexes of every registered database model without a connection', () => {
    const declared = collectDeclaredIndexes(Object.values(databaseMongoose.models));

    expect(declared.length).toBeGreaterThan(50);
    expect(declared).toContainEqual(
      expect.objectContaining({
        collection: 'useractivitycounters',
        key: [
          ['userId', 1],
          ['action', 1],
        ],
        options: { unique: true },
      })
    );
  });
});

describe('undefined scan', () => {
  // The Node driver writes a JS undefined as BSON null whatever ignoreUndefined says, so a real
  // BSON undefined is produced by server-side JavaScript.
  const seedUndefined = async (collection: mongo.Collection, id: number, path: 'top' | 'nested') => {
    const body =
      path === 'top'
        ? 'function(doc) { doc.gone = undefined; return doc; }'
        : 'function(doc) { doc.profile = { gone: undefined }; return doc; }';
    await collection.insertOne({ _id: id as unknown as mongo.ObjectId, kept: null });
    await collection.updateOne({ _id: id as unknown as mongo.ObjectId }, [
      { $replaceWith: { $function: { body, args: ['$$ROOT'], lang: 'js' } } },
    ]);
  };

  it('finds seeded documents top-level by default and nested on request', async () => {
    const { seed, read } = freshDatabase();
    const things = seed.collection('things');
    await seedUndefined(things, 1, 'top');
    await seedUndefined(things, 2, 'nested');
    await things.insertOne({ _id: 3 as unknown as mongo.ObjectId, kept: null, profile: { name: null } });
    expect(holdsUndefined(await read.collection('things').findOne({ _id: 1 as unknown as mongo.ObjectId }))).toBe(true);

    const topLevel = await snapshotAt(read, '2026-01-01T00:00:00.000Z', { undefinedScan: 'top-level' });
    const nested = await snapshotAt(read, '2026-01-01T00:00:00.000Z', { undefinedScan: 'nested' });

    expect(topLevel.checks.undefinedValues).toEqual({
      mode: 'top-level',
      collections: [{ collection: 'things', documents: 1 }],
      unfinished: [],
    });
    expect(nested.checks.undefinedValues).toEqual({
      mode: 'nested',
      collections: [{ collection: 'things', documents: 2 }],
      unfinished: [],
    });
  });

  it('reports a collection it could not finish within the time limit', async () => {
    const { seed, read } = freshDatabase();
    await seed.collection('things').insertMany(Array.from({ length: 3000 }, (_, i) => ({ i })));

    const snapshot = await snapshotAt(read, '2026-01-01T00:00:00.000Z', {
      undefinedScan: 'nested',
      scanTimeLimitMs: 1,
    });

    expect(snapshot.checks.undefinedValues?.unfinished).toEqual([
      { collection: 'things', reason: 'time limit exceeded' },
    ]);
  });
});

describe('read-only guard', () => {
  it('sends only read commands and leaves collections and indexes untouched', async () => {
    const { seed, read } = freshDatabase();
    await seedRepresentativeCollections(seed);
    await seed.collection('things').insertOne({ a: 1 });
    const state = async () => ({
      collections: (await seed.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).sort(),
      users: await seed.collection('users').indexes(),
    });
    const before = await state();
    const declared = collectDeclaredIndexes([
      {
        modelName: 'Ghost',
        collection: { collectionName: 'ghosts' },
        schema: new Schema({ name: { type: String, index: true } }),
      },
      ...Object.values(databaseMongoose.models),
    ]);

    const recorder = recordCommands(reader);
    await snapshotAt(read, '2026-01-01T00:00:00.000Z', { declaredIndexes: declared, undefinedScan: 'top-level' });
    await snapshotAt(read, '2026-01-01T00:00:00.000Z', { declaredIndexes: declared, undefinedScan: 'nested' });
    recorder.stop();

    expect(recorder.commands.length).toBeGreaterThan(0);
    expect(recorder.violations).toEqual([]);
    expect(new Set(recorder.commands).size).toBeGreaterThan(3);
    expect(recorder.commands.every(name => READ_ONLY_COMMANDS.has(name))).toBe(true);
    expect(await state()).toEqual(before);
  });

  it('rejects write, DDL and write-stage aggregate commands', () => {
    for (const commandName of ['insert', 'update', 'delete', 'createIndexes', 'create', 'drop', 'collMod']) {
      expect(isReadOnlyCommand({ commandName, command: {} })).toBe(false);
    }
    expect(isReadOnlyCommand({ commandName: 'aggregate', command: { pipeline: [{ $merge: 'x' }] } })).toBe(false);
    expect(isReadOnlyCommand({ commandName: 'aggregate', command: { pipeline: [{ $out: 'x' }] } })).toBe(false);
    expect(isReadOnlyCommand({ commandName: 'aggregate', command: { pipeline: [{ $match: {} }] } })).toBe(true);
  });
});
