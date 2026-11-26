import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose, { type mongo } from 'mongoose';
// Imported for its side effect: registers every model so collections and paths can be pinned.
import '@bike4mind/database';
import { SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import {
  apiKeySecretContext,
  ciphertextVersionPrefix,
  decryptSecret,
  encryptSecret,
  generateEncryptionKey,
  mcpEnvSecretContext,
} from '@bike4mind/utils/security';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../database/src/__test__/createMongoServer';
import {
  SWEEP_FIELDS,
  formatSweep,
  sweepExitCode,
  sweepLabel,
  sweepStoredSecrets,
  type SweepField,
  type SweepMode,
  type SweepRow,
} from './reencrypt-stored-secrets-sweep';
import { run } from './reencrypt-stored-secrets';

const mocks = vi.hoisted(() => ({ resources: {} as Record<string, string | undefined>, stage: 'test' }));
vi.mock('./encrypt-admin-settings-and-apikeys', () => ({
  getResource: (name: string) => mocks.resources[name],
  getStage: () => mocks.stage,
}));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

type Doc = mongo.Document;
type Kind = 'old' | 'current' | 'plain' | 'empty' | 'masked';

const oldKey = generateEncryptionKey();
const newKey = generateEncryptionKey();
const otherKey = generateEncryptionKey();

/** Mixed (schemaless) subtrees: only the parent can be pinned, the schema does not declare what is under it. */
const MIXED_PARENTS: Record<string, string> = {
  'users.oauthCredentials.accessToken': 'oauthCredentials',
  'users.oauthCredentials.refreshToken': 'oauthCredentials',
  'adminsettings.settingValue': 'settingValue',
};

/** Collections are slow to create, so the tests that do not need the whole table seed these. */
const SUBSET_LABELS = [
  'apikeys.apiKey',
  'mcpservers.envVariables[].value',
  'adminsettings.settingValue',
  'orgwebhookconfigs.secret',
];
const subsetFields = (): SweepField[] => SWEEP_FIELDS.filter(field => SUBSET_LABELS.includes(sweepLabel(field)));

let server: Awaited<ReturnType<typeof createMongoServer>>;
// Seeds and inspects through its own client: run() connects (and disconnects) mongoose's default
// connection, where the models live, so it must not share it.
let client: mongo.MongoClient;
let db: mongo.Db;
let counter = 0;

beforeAll(async () => {
  server = await createMongoServer();
  client = await new mongoose.mongo.MongoClient(server.getUri()).connect();
  db = client.db('reencrypt_main');
});
afterAll(async () => {
  await client.close();
  await server.stop();
});
beforeEach(async () => {
  await db.dropDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Seeded {
  label: string;
  collection: string;
  id: mongoose.Types.ObjectId;
  /** Update path of the value inside its document, array positions as indexes. */
  location: string;
  kind: Kind;
  bound: boolean;
  stored: string;
  plaintext?: string;
  context?: string;
}

interface Seed {
  seeded: Seeded[];
  plaintexts: string[];
  ids: string[];
  pending: Map<string, Doc[]>;
}

const newSeed = (): Seed => ({ seeded: [], plaintexts: [], ids: [], pending: new Map() });

const nest = (segments: string[], value: unknown): Doc =>
  segments.reduceRight<unknown>((inner, segment) => ({ [segment]: inner }), value) as Doc;

const getAt = (root: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
      root
    );

function setAt(root: Doc, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const parent = keys.length === 0 ? root : (getAt(root, keys.join('.')) as Record<string, unknown>);
  parent[last] = value;
}

const stamp = (n: number): Doc => ({
  createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, n % 60)),
  updatedAt: new Date(Date.UTC(2024, 5, 1, 0, 0, n % 60)),
  expiresAt: new Date(Date.UTC(2030, 0, 1, 0, 0, n % 60)),
  deletedAt: n % 5 === 0 ? new Date(Date.UTC(2025, 0, 1)) : null,
  note: 'unrelated-fixture',
  meta: { sibling: 'sibling-fixture', counts: [1, 2, 3] },
});

/** Rebuilds the owning context with the real helpers, independent of the table's own functions. */
function contextFor(label: string, owner: { userId: string; id: string }, item?: { key: string }): string {
  if (label === 'apikeys.apiKey') return apiKeySecretContext(owner.userId, owner.id);
  if (label === 'mcpservers.envVariables[].value') return mcpEnvSecretContext(owner.userId, owner.id, item!.key);
  throw new Error(`The table gained a context-bound field (${label}): teach this test how to build its context`);
}

function storedValue(seed: Seed, kind: Kind, context?: string): { stored: string; plaintext?: string } {
  if (kind === 'empty') return { stored: '' };
  if (kind === 'masked') return { stored: `${SENSITIVE_SETTING_MASK}abcd` };
  const plaintext = kind === 'plain' ? `plain-fixture-${++counter}` : `secret-fixture-${++counter}`;
  seed.plaintexts.push(plaintext);
  if (kind === 'plain') return { stored: plaintext, plaintext };
  return { stored: encryptSecret(plaintext, kind === 'old' ? oldKey : newKey, context), plaintext };
}

async function insert(target: mongo.Db, seed: Seed, collection: string, doc: Doc): Promise<void> {
  await target.collection(collection).insertOne(doc);
  seed.ids.push(String(doc._id));
}

/** Table-wide seeding queues its documents and writes each collection in one batch. */
function queue(seed: Seed, collection: string, doc: Doc): void {
  seed.pending.set(collection, [...(seed.pending.get(collection) ?? []), doc]);
  seed.ids.push(String(doc._id));
}

async function flush(target: mongo.Db, seed: Seed): Promise<void> {
  for (const [collection, docs] of seed.pending) await target.collection(collection).insertMany(docs);
  seed.pending.clear();
}

const variantsFor = (field: SweepField): { kind: Kind; bound: boolean }[] => [
  { kind: 'old', bound: false },
  ...(field.context ? [{ kind: 'old' as const, bound: true }] : []),
  { kind: 'current', bound: false },
  ...(field.context ? [{ kind: 'current' as const, bound: true }] : []),
  { kind: 'plain', bound: false },
  { kind: 'empty', bound: false },
];

const siblingsFor = (field: SweepField): Record<string, string> => ({
  ...Object.fromEntries((field.needs ?? []).map(name => [name, `${name}-fixture-${++counter}`])),
  ...(field.collection === 'adminsettings' ? { settingName: `setting-fixture-${++counter}` } : {}),
});

/** One document (or one array item) per value kind, built from the table's path alone. */
function seedField(seed: Seed, field: SweepField): void {
  const label = sweepLabel(field);
  const segments = field.path.split('.');
  const arrayAt = segments.findIndex(segment => segment.endsWith('[]'));
  const record = (id: mongoose.Types.ObjectId, location: string, kind: Kind, bound: boolean, context?: string) => {
    const value = storedValue(seed, kind, context);
    seed.seeded.push({ label, collection: field.collection, id, location, kind, bound, context, ...value });
    return value.stored;
  };

  if (arrayAt === -1) {
    for (const variant of variantsFor(field)) {
      const id = new mongoose.Types.ObjectId();
      const siblings = siblingsFor(field);
      const context = variant.bound ? contextFor(label, { userId: siblings.userId, id: String(id) }) : undefined;
      const stored = record(id, segments.join('.'), variant.kind, variant.bound, context);
      queue(seed, field.collection, {
        _id: id,
        ...siblings,
        ...nest(segments, stored),
        ...stamp(++counter),
      });
    }
    return;
  }

  const head = [...segments.slice(0, arrayAt), segments[arrayAt].slice(0, -2)];
  const tail = segments.slice(arrayAt + 1);
  if (tail.length === 0) throw new Error(`${label}: an array of bare ciphertexts needs its own seeding`);
  const id = new mongoose.Types.ObjectId();
  const siblings = siblingsFor(field);
  const items = variantsFor(field).map((variant, index) => {
    const key = `KEY_${index}`;
    const context = variant.bound ? contextFor(label, { userId: siblings.userId, id: String(id) }, { key }) : undefined;
    const stored = record(id, [...head, String(index), ...tail].join('.'), variant.kind, variant.bound, context);
    return { ...nest(tail, stored), key, label: `item-${index}` };
  });
  queue(seed, field.collection, { _id: id, ...siblings, ...nest(head, items), ...stamp(++counter) });
}

/** The deep field has no fixed shape: add the shapes it is known to hold, and a few it must leave alone. */
function seedDeepExtras(seed: Seed, field: SweepField): void {
  const label = sweepLabel(field);
  if (label !== 'adminsettings.settingValue') {
    throw new Error(`The table gained a deep field (${label}): teach this test its stored shapes`);
  }
  const track = (id: mongoose.Types.ObjectId, location: string, kind: Kind) => {
    const value = storedValue(seed, kind);
    seed.seeded.push({ label, collection: field.collection, id, location, kind, bound: false, ...value });
    return value.stored;
  };
  const name = () => `setting-fixture-${++counter}`;

  const sreId = new mongoose.Types.ObjectId();
  const repos = [
    {
      owner: 'owner-fixture-a',
      repo: 'repo-fixture-a',
      webhookSecret: track(sreId, 'settingValue.repos.0.webhookSecret', 'old'),
      callbackToken: track(sreId, 'settingValue.repos.0.callbackToken', 'old'),
    },
    {
      owner: 'owner-fixture-b',
      repo: 'repo-fixture-b',
      webhookSecret: track(sreId, 'settingValue.repos.1.webhookSecret', 'current'),
      callbackToken: track(sreId, 'settingValue.repos.1.callbackToken', 'empty'),
    },
  ];
  queue(seed, 'adminsettings', {
    _id: sreId,
    settingName: 'sreAgentConfig',
    settingValue: { repos, mode: 'sibling-fixture' },
    ...stamp(++counter),
  });

  const listId = new mongoose.Types.ObjectId();
  queue(seed, 'adminsettings', {
    _id: listId,
    settingName: name(),
    settingValue: [track(listId, 'settingValue.0', 'old'), 'plain-sibling-fixture'],
    ...stamp(++counter),
  });

  const maskedId = new mongoose.Types.ObjectId();
  queue(seed, 'adminsettings', {
    _id: maskedId,
    settingName: name(),
    settingValue: track(maskedId, 'settingValue', 'masked'),
    ...stamp(++counter),
  });

  const deletedId = new mongoose.Types.ObjectId();
  queue(seed, 'adminsettings', {
    _id: deletedId,
    settingName: name(),
    settingValue: track(deletedId, 'settingValue', 'old'),
    ...stamp(++counter),
    deletedAt: new Date(Date.UTC(2025, 2, 3)),
  });

  for (const settingValue of [42, true, null, { count: 3, nested: { enabled: false } }]) {
    queue(seed, 'adminsettings', {
      _id: new mongoose.Types.ObjectId(),
      settingName: name(),
      settingValue,
      ...stamp(++counter),
    });
  }
}

async function seedTable(target: mongo.Db, table: SweepField[] = SWEEP_FIELDS): Promise<Seed> {
  const seed = newSeed();
  for (const field of table) {
    seedField(seed, field);
    if (field.deep) seedDeepExtras(seed, field);
  }
  await flush(target, seed);
  return seed;
}

const tableCollections = (): string[] => [...new Set(SWEEP_FIELDS.map(field => field.collection))];

async function snapshot(target: mongo.Db): Promise<Record<string, Doc[]>> {
  const entries = await Promise.all(
    tableCollections().map(async name => [name, await target.collection(name).find({}).sort({ _id: 1 }).toArray()])
  );
  return Object.fromEntries(entries);
}

const docOf = (snap: Record<string, Doc[]>, collection: string, id: unknown): Doc =>
  snap[collection].find(doc => String(doc._id) === String(id))!;

interface Counts {
  old: number;
  current: number;
}

function countsOf(seeded: Seeded[]): Map<string, Counts> {
  const counts = new Map<string, Counts>(SWEEP_FIELDS.map(field => [sweepLabel(field), { old: 0, current: 0 }]));
  for (const entry of seeded) {
    if (entry.kind === 'old') counts.get(entry.label)!.old++;
    if (entry.kind === 'current') counts.get(entry.label)!.current++;
  }
  return counts;
}

function expectRows(
  rows: SweepRow[],
  counts: Map<string, Counts>,
  expected: (counts: Counts) => Omit<SweepRow, 'label'>
) {
  expect(rows.map(row => row.label)).toEqual(SWEEP_FIELDS.map(sweepLabel));
  for (const { label, ...actual } of rows) expect(actual, label).toEqual(expected(counts.get(label)!));
}

/** `previousKey: null` leaves the previous key out entirely. */
const sweep = (target: mongo.Db, mode: SweepMode, previousKey: string | null = oldKey): Promise<SweepRow[]> =>
  sweepStoredSecrets(target, { currentKey: newKey, previousKey: previousKey ?? undefined, mode });

const rowOf = (rows: SweepRow[], label: string): SweepRow => rows.find(row => row.label === label)!;

describe('re-encrypt table', () => {
  it('pins every collection to its model and every path to its schema', () => {
    const models = mongoose.modelNames().map(name => mongoose.model(name));
    const labels = SWEEP_FIELDS.map(sweepLabel);
    expect(new Set(labels).size).toBe(labels.length);

    for (const field of SWEEP_FIELDS) {
      const label = sweepLabel(field);
      const owners = models.filter(model => model.collection.collectionName === field.collection);
      expect(
        owners.map(model => model.modelName),
        label
      ).toHaveLength(1);
      const { schema } = owners[0];

      const segments = field.path.split('.');
      for (const [index, segment] of segments.entries()) {
        if (!segment.endsWith('[]')) continue;
        const arrayPath = segments
          .slice(0, index + 1)
          .join('.')
          .replaceAll('[]', '');
        expect(schema.path(arrayPath)?.instance, `${label}: ${arrayPath}`).toBe('Array');
      }

      const mixedParent = MIXED_PARENTS[label];
      if (mixedParent) {
        expect(schema.path(mixedParent)?.instance, `${label}: ${mixedParent}`).toBe('Mixed');
      } else {
        expect(schema.path(field.path.replaceAll('[]', ''))?.instance, label).toBe('String');
      }
    }
  });

  it('keeps every Mixed parent in the table', () => {
    const labels = new Set(SWEEP_FIELDS.map(sweepLabel));
    for (const label of Object.keys(MIXED_PARENTS)) expect(labels.has(label), label).toBe(true);
  });
});

describe('re-encrypt sweep', () => {
  it('rotates every field of the table: verify, dry-run, rewrite, rewrite again, verify', async () => {
    const seed = await seedTable(db);
    const counts = countsOf(seed.seeded);
    for (const field of SWEEP_FIELDS) {
      expect(counts.get(sweepLabel(field))!.old, `${sweepLabel(field)} has an old-key value`).toBeGreaterThan(0);
    }
    const before = await snapshot(db);

    // verify answers with the current key alone, so every old-key value is not-current
    const verifyBefore = await sweep(db, 'verify');
    expectRows(verifyBefore, counts, c => ({
      checked: c.old + c.current,
      current: c.current,
      rotated: 0,
      conflicts: 0,
      unreadable: c.old,
    }));
    expect(sweepExitCode(verifyBefore)).toBe(1);
    expect(await snapshot(db)).toEqual(before);

    const dryRun = await sweep(db, 'dry-run');
    expectRows(dryRun, counts, c => ({
      checked: c.old + c.current,
      current: c.current,
      rotated: c.old,
      conflicts: 0,
      unreadable: 0,
    }));
    expect(sweepExitCode(dryRun)).toBe(0);
    expect(await snapshot(db)).toEqual(before);

    // Without a previous key an old-key value cannot be opened: nothing is rotated or written.
    for (const mode of ['dry-run', 'rewrite'] as const) {
      const withoutPrevious = await sweep(db, mode, null);
      expectRows(withoutPrevious, counts, c => ({
        checked: c.old + c.current,
        current: c.current,
        rotated: 0,
        conflicts: 0,
        unreadable: c.old,
      }));
      expect(sweepExitCode(withoutPrevious), mode).toBe(1);
    }
    expect(await snapshot(db)).toEqual(before);

    const rewrite = await sweep(db, 'rewrite');
    expectRows(rewrite, counts, c => ({
      checked: c.old + c.current,
      current: c.current,
      rotated: c.old,
      conflicts: 0,
      unreadable: 0,
    }));
    expect(sweepExitCode(rewrite)).toBe(0);

    const rewritten = await snapshot(db);
    const restored = await snapshot(db);
    for (const entry of seed.seeded) {
      if (entry.kind !== 'old') continue;
      const where = `${entry.label} ${entry.location}`;
      const doc = docOf(restored, entry.collection, entry.id);
      const value = getAt(doc, entry.location) as string;

      expect(value, where).not.toBe(entry.stored);
      expect(decryptSecret(value, newKey, entry.context), where).toBe(entry.plaintext);
      expect(() => decryptSecret(value, oldKey, entry.context), where).toThrow();
      expect(value.startsWith(ciphertextVersionPrefix), where).toBe(entry.bound);
      if (entry.bound) expect(() => decryptSecret(value, newKey), where).toThrow();

      setAt(doc, entry.location, entry.stored);
    }
    // With each rotated value put back, nothing else in any document moved: current, plaintext,
    // empty and masked values, timestamps, soft-delete marks and sibling fields.
    expect(restored).toEqual(before);

    const second = await sweep(db, 'rewrite');
    expectRows(second, counts, c => ({
      checked: c.old + c.current,
      current: c.old + c.current,
      rotated: 0,
      conflicts: 0,
      unreadable: 0,
    }));
    expect(sweepExitCode(second)).toBe(0);
    expect(await snapshot(db)).toEqual(rewritten);

    const verifyAfter = await sweep(db, 'verify', null);
    expectRows(verifyAfter, counts, c => ({
      checked: c.old + c.current,
      current: c.old + c.current,
      rotated: 0,
      conflicts: 0,
      unreadable: 0,
    }));
    expect(sweepExitCode(verifyAfter)).toBe(0);
    expect(await snapshot(db)).toEqual(rewritten);
  });

  it('leaves a value that changed between the read and the write, and rotates it on the next run', async () => {
    const seed = newSeed();
    const first = new mongoose.Types.ObjectId();
    const second = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    await insert(db, seed, 'orgwebhookconfigs', { _id: first, secret: encryptSecret('first-fixture', oldKey) });
    await insert(db, seed, 'orgwebhookconfigs', { _id: second, secret: encryptSecret('second-fixture', oldKey) });
    await insert(db, seed, 'jirawebhookconfigs', { _id: other, secret: encryptSecret('other-fixture', oldKey) });

    type UpdateOne = (
      this: mongo.Collection,
      filter: mongo.Filter<Doc>,
      update: mongo.UpdateFilter<Doc>
    ) => Promise<unknown>;
    const originalUpdateOne = mongoose.mongo.Collection.prototype.updateOne as unknown as UpdateOne;
    const concurrent = encryptSecret('concurrent-fixture', oldKey);
    let interceptedId: unknown;
    vi.spyOn(mongoose.mongo.Collection.prototype, 'updateOne').mockImplementation(function (
      this: mongo.Collection,
      filter: mongo.Filter<Doc>,
      update: mongo.UpdateFilter<Doc>
    ) {
      if (this.collectionName === 'orgwebhookconfigs' && interceptedId === undefined) {
        interceptedId = filter._id;
        // Another writer replaces the value after this sweep read it.
        return originalUpdateOne
          .call(this, { _id: filter._id }, { $set: { secret: concurrent } })
          .then(() => originalUpdateOne.call(this, filter, update));
      }
      return originalUpdateOne.call(this, filter, update);
    } as never);

    const rows = await sweepStoredSecrets(db, { currentKey: newKey, previousKey: oldKey, mode: 'rewrite' });
    vi.restoreAllMocks();

    expect(interceptedId).toBeDefined();
    expect(rowOf(rows, 'orgwebhookconfigs.secret')).toMatchObject({
      checked: 2,
      current: 0,
      rotated: 1,
      conflicts: 1,
      unreadable: 0,
    });
    expect(rowOf(rows, 'jirawebhookconfigs.secret')).toMatchObject({ checked: 1, rotated: 1, conflicts: 0 });
    expect(sweepExitCode(rows)).toBe(1);

    const intercepted = await db
      .collection('orgwebhookconfigs')
      .findOne({ _id: interceptedId as mongoose.Types.ObjectId });
    expect(intercepted!.secret).toBe(concurrent);

    const next = await sweepStoredSecrets(db, { currentKey: newKey, previousKey: oldKey, mode: 'rewrite' });
    expect(rowOf(next, 'orgwebhookconfigs.secret')).toMatchObject({ checked: 2, current: 1, rotated: 1, conflicts: 0 });
    expect(sweepExitCode(next)).toBe(0);
    const settled = await db.collection('orgwebhookconfigs').findOne({ _id: interceptedId as mongoose.Types.ObjectId });
    expect(decryptSecret(settled!.secret, newKey)).toBe('concurrent-fixture');
  });

  it('counts values it cannot use as unreadable, leaves them untouched and exits 1', async () => {
    const seed = newSeed();
    const hooks = new mongoose.Types.ObjectId();
    const elsewhere = new mongoose.Types.ObjectId();
    const unboundField = new mongoose.Types.ObjectId();
    const wrongOwner = new mongoose.Types.ObjectId();
    const dotted = new mongoose.Types.ObjectId();
    const good = new mongoose.Types.ObjectId();
    await insert(db, seed, 'orgwebhookconfigs', { _id: hooks, secret: encryptSecret('neither-fixture', otherKey) });
    await insert(db, seed, 'orgwebhookconfigs', { _id: good, secret: encryptSecret('good-fixture', oldKey) });
    // A context-bound value at a path whose field defines no context cannot be opened.
    await insert(db, seed, 'jirawebhookconfigs', {
      _id: unboundField,
      secret: encryptSecret('bound-fixture', oldKey, 'some-context'),
    });
    await insert(db, seed, 'apikeys', {
      _id: wrongOwner,
      userId: 'owner-fixture',
      apiKey: encryptSecret('owner-fixture-key', oldKey, apiKeySecretContext('someone-else', String(wrongOwner))),
    });
    // A key with a dot cannot be named in an update path.
    await insert(db, seed, 'adminsettings', {
      _id: dotted,
      settingName: 'dotted-fixture',
      settingValue: { 'dotted.key': encryptSecret('dotted-fixture-value', oldKey) },
    });
    await insert(db, seed, 'systemsecrets', {
      _id: elsewhere,
      encryptedValue: encryptSecret('elsewhere-fixture', otherKey),
    });
    const before = await snapshot(db);

    for (const mode of ['dry-run', 'rewrite'] as const) {
      const rows = await sweep(db, mode);
      expect(rowOf(rows, 'orgwebhookconfigs.secret'), mode).toMatchObject({
        checked: 2,
        rotated: 1,
        unreadable: 1,
        conflicts: 0,
      });
      expect(rowOf(rows, 'jirawebhookconfigs.secret'), mode).toMatchObject({ checked: 1, rotated: 0, unreadable: 1 });
      expect(rowOf(rows, 'apikeys.apiKey'), mode).toMatchObject({ checked: 1, rotated: 0, unreadable: 1 });
      expect(rowOf(rows, 'adminsettings.settingValue'), mode).toMatchObject({ checked: 1, rotated: 0, unreadable: 1 });
      expect(rowOf(rows, 'systemsecrets.encryptedValue'), mode).toMatchObject({
        checked: 1,
        rotated: 0,
        unreadable: 1,
      });
      expect(sweepExitCode(rows), mode).toBe(1);
    }

    const after = await snapshot(db);
    const rotated = docOf(after, 'orgwebhookconfigs', good);
    expect(decryptSecret(rotated.secret, newKey)).toBe('good-fixture');
    // Everything but the one usable value is byte-identical.
    setAt(rotated, 'secret', docOf(before, 'orgwebhookconfigs', good).secret);
    expect(after).toEqual(before);
  });

  it('rotates each element of a reordered array with its own key context', async () => {
    const seed = newSeed();
    const id = new mongoose.Types.ObjectId();
    const userId = 'owner-fixture';
    const context = (key: string) => mcpEnvSecretContext(userId, String(id), key);
    const plaintexts: Record<string, string> = {
      ZED: 'zed-fixture',
      ALPHA: 'alpha-fixture',
      MID: 'mid-fixture',
      LEGACY: 'legacy-fixture',
      READY: 'ready-fixture',
    };
    const envVariables = [
      { key: 'ZED', value: encryptSecret(plaintexts.ZED, oldKey, context('ZED')) },
      { key: 'ALPHA', value: encryptSecret(plaintexts.ALPHA, oldKey, context('ALPHA')) },
      { key: 'MID', value: encryptSecret(plaintexts.MID, oldKey, context('MID')) },
      { key: 'LEGACY', value: encryptSecret(plaintexts.LEGACY, oldKey) },
      { key: 'UNSET', value: '' },
      { key: 'READY', value: encryptSecret(plaintexts.READY, newKey, context('READY')) },
    ];
    await insert(db, seed, 'mcpservers', { _id: id, userId, name: 'server-fixture', envVariables });

    const rows = await sweep(db, 'rewrite');
    expect(rowOf(rows, 'mcpservers.envVariables[].value')).toMatchObject({
      checked: 5,
      current: 1,
      rotated: 4,
      unreadable: 0,
      conflicts: 0,
    });
    expect(sweepExitCode(rows)).toBe(0);

    const stored = (await db.collection('mcpservers').findOne({ _id: id }))!;
    expect(stored.envVariables.map((variable: { key: string }) => variable.key)).toEqual(envVariables.map(v => v.key));
    for (const variable of stored.envVariables as { key: string; value: string }[]) {
      if (variable.key === 'UNSET') {
        expect(variable.value).toBe('');
      } else if (variable.key === 'LEGACY') {
        expect(variable.value.startsWith(ciphertextVersionPrefix)).toBe(false);
        expect(decryptSecret(variable.value, newKey)).toBe(plaintexts.LEGACY);
      } else {
        expect(variable.value.startsWith(ciphertextVersionPrefix), variable.key).toBe(true);
        expect(decryptSecret(variable.value, newKey, context(variable.key)), variable.key).toBe(
          plaintexts[variable.key]
        );
        expect(() => decryptSecret(variable.value, newKey, context('UNSET')), variable.key).toThrow();
      }
    }
  });

  it('rotates soft-deleted rows too', async () => {
    const seed = newSeed();
    const deletedAt = new Date(Date.UTC(2025, 3, 4));
    const keyId = new mongoose.Types.ObjectId();
    const settingId = new mongoose.Types.ObjectId();
    const keyContext = apiKeySecretContext('owner-fixture', String(keyId));
    await insert(db, seed, 'apikeys', {
      _id: keyId,
      userId: 'owner-fixture',
      apiKey: encryptSecret('provider-key-fixture', oldKey, keyContext),
      deletedAt,
    });
    await insert(db, seed, 'adminsettings', {
      _id: settingId,
      settingName: 'deleted-setting-fixture',
      settingValue: encryptSecret('setting-fixture', oldKey),
      deletedAt,
    });

    const rows = await sweep(db, 'rewrite');
    expect(rowOf(rows, 'apikeys.apiKey')).toMatchObject({ checked: 1, rotated: 1 });
    expect(rowOf(rows, 'adminsettings.settingValue')).toMatchObject({ checked: 1, rotated: 1 });

    const apiKey = (await db.collection('apikeys').findOne({ _id: keyId }))!;
    const setting = (await db.collection('adminsettings').findOne({ _id: settingId }))!;
    expect(decryptSecret(apiKey.apiKey, newKey, keyContext)).toBe('provider-key-fixture');
    expect(decryptSecret(setting.settingValue, newKey)).toBe('setting-fixture');
    expect(apiKey.deletedAt).toEqual(deletedAt);
    expect(setting.deletedAt).toEqual(deletedAt);
  });

  it('reports no ciphertext and exits 2 for an empty database', async () => {
    for (const mode of ['verify', 'dry-run', 'rewrite'] as const) {
      const rows = await sweep(db, mode);
      expect(rows).toHaveLength(SWEEP_FIELDS.length);
      expect(
        rows.every(row => row.checked === 0 && row.current === 0 && row.rotated === 0 && row.unreadable === 0),
        mode
      ).toBe(true);
      expect(sweepExitCode(rows), mode).toBe(2);
    }
  });

  it('exits 2 when the database holds no ciphertext, only plaintext and empty values', async () => {
    const seed = newSeed();
    await insert(db, seed, 'orgwebhookconfigs', { secret: 'plain-fixture' });
    await insert(db, seed, 'jirawebhookconfigs', { secret: '' });
    expect(sweepExitCode(await sweep(db, 'verify'))).toBe(2);
  });
});

describe('re-encrypt output', () => {
  it('prints only labels and counts', async () => {
    const table = subsetFields();
    const seed = await seedTable(db, table);
    const outputs: { mode: SweepMode; text: string; rows: SweepRow[] }[] = [];
    for (const mode of ['verify', 'dry-run', 'rewrite'] as const) {
      const rows = await sweepStoredSecrets(db, { currentKey: newKey, previousKey: oldKey, mode, fields: table });
      outputs.push({ mode, rows, text: formatSweep(rows, mode) });
    }

    const rotated = await snapshot(db);
    const ciphertexts = [
      ...seed.seeded.filter(entry => entry.stored.includes(':')).map(entry => entry.stored),
      ...seed.seeded
        .filter(entry => entry.kind === 'old')
        .map(entry => getAt(docOf(rotated, entry.collection, entry.id), entry.location) as string),
    ];
    expect(seed.plaintexts.length).toBeGreaterThan(0);
    expect(ciphertexts.length).toBeGreaterThan(0);
    expect(seed.ids.length).toBeGreaterThan(0);

    const shape: Record<SweepMode, RegExp> = {
      verify: /^\S+ +checked=\d+ +current=\d+ +not-current=\d+$/,
      'dry-run': /^\S+ +checked=\d+ +current=\d+ +would-rotate=\d+ +conflicts=\d+ +unreadable=\d+$/,
      rewrite: /^\S+ +checked=\d+ +current=\d+ +rotated=\d+ +conflicts=\d+ +unreadable=\d+$/,
    };
    for (const { mode, text, rows } of outputs) {
      for (const secret of [...seed.plaintexts, ...ciphertexts, ...seed.ids]) {
        expect(text, mode).not.toContain(secret);
      }
      const lines = text.split('\n');
      expect(lines, mode).toHaveLength(rows.length + 1);
      for (const line of lines) expect(line, mode).toMatch(shape[mode]);
      expect(lines[lines.length - 1], mode).toMatch(/^TOTAL +checked=/);
      expect(lines[0], mode).toContain(rows[0].label);
    }

    const text = Object.fromEntries(outputs.map(output => [output.mode, output.text])) as Record<SweepMode, string>;
    expect(text.verify).toContain('not-current=');
    expect(text.verify).not.toContain('would-rotate=');
    expect(text['dry-run']).toContain('would-rotate=');
    expect(text['dry-run']).not.toContain('not-current=');
    expect(text.rewrite).toContain(' rotated=');
    expect(text.rewrite).not.toContain('would-rotate=');
  });

  it('totals every column', () => {
    const rows: SweepRow[] = [
      { label: 'a.one', checked: 3, current: 1, rotated: 1, conflicts: 1, unreadable: 0 },
      { label: 'b.two', checked: 4, current: 0, rotated: 2, conflicts: 0, unreadable: 2 },
    ];
    const total = formatSweep(rows, 'rewrite').split('\n').at(-1)!;
    expect(total).toMatch(/^TOTAL +checked=7 +current=1 +rotated=3 +conflicts=1 +unreadable=2$/);
  });
});

describe('re-encrypt CLI', () => {
  const dbName = 'reencrypt_cli';
  const uriFor = (name = dbName): string => server.getUri().replace(/\/?$/, `/${name}`);
  let out: string[];
  let err: string[];
  let seed: Seed;

  const output = (): string => [...out, ...err].join('\n');
  const expectNoLeaks = (): void => {
    const text = output();
    expect(text).not.toContain(newKey);
    expect(text).not.toContain(oldKey);
    expect(text).not.toContain(otherKey);
    for (const secret of [...seed.plaintexts, ...seed.seeded.map(entry => entry.stored).filter(Boolean), ...seed.ids]) {
      expect(text).not.toContain(secret);
    }
  };
  const cliDb = (): mongo.Db => client.db(dbName);

  beforeEach(async () => {
    await cliDb().dropDatabase();
    out = [];
    err = [];
    seed = newSeed();
    mocks.resources = {
      SECRET_ENCRYPTION_KEY: newKey,
      SECRET_ENCRYPTION_KEY_PREVIOUS: oldKey,
      MONGODB_URI: uriFor(),
    };
    mocks.stage = 'test';
    vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ')));
    vi.stubEnv('MONGODB_URI', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '');
    vi.stubEnv('SECRET_ENCRYPTION_KEY_PREVIOUS', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects an unknown flag and the two mode flags together', async () => {
    expect(await run(['--bogus'])).toBe(2);
    expect(await run(['--dry-run', '--bogus'])).toBe(2);
    expect(await run(['stray'])).toBe(2);
    expect(await run(['--dry-run', '--verify'])).toBe(2);
    expect(err.join('\n')).toContain('Usage');
    expectNoLeaks();
  });

  it('prints help without a database', async () => {
    mocks.resources = {};
    expect(await run(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('--verify');
    expect(err).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too short', 'abcdef'],
    ['not hex', 'z'.repeat(64)],
    ['too long', 'a'.repeat(65)],
  ])('exits 2 for a %s current key in every mode', async (_name, value) => {
    mocks.resources.SECRET_ENCRYPTION_KEY = value;
    for (const argv of [[], ['--dry-run'], ['--verify']]) expect(await run(argv)).toBe(2);
    expect(err.join('\n')).toContain('SECRET_ENCRYPTION_KEY is not configured');
    expectNoLeaks();
  });

  it('needs a previous key to rotate or dry-run, but not to verify', async () => {
    seed = await seedTable(cliDb(), subsetFields());
    for (const previous of [undefined, '', 'short-key']) {
      mocks.resources.SECRET_ENCRYPTION_KEY_PREVIOUS = previous;
      expect(await run([])).toBe(2);
      expect(await run(['--dry-run'])).toBe(2);
    }
    expect(err.join('\n')).toContain('SECRET_ENCRYPTION_KEY_PREVIOUS must hold the old key');

    mocks.resources.SECRET_ENCRYPTION_KEY_PREVIOUS = undefined;
    // Not under the current key yet, so verify answers 1: it ran, which is the point.
    expect(await run(['--verify'])).toBe(1);
    expect(out.join('\n')).toContain('Mode: VERIFY');
    expectNoLeaks();
  });

  it('exits 2 when the previous key equals the current key', async () => {
    mocks.resources.SECRET_ENCRYPTION_KEY_PREVIOUS = newKey;
    expect(await run([])).toBe(2);
    expect(await run(['--dry-run'])).toBe(2);
    expect(err.join('\n')).toContain('nothing to rotate');
    expectNoLeaks();
  });

  it('exits 2 with no database URI, and when the URI needs a stage and none is set', async () => {
    mocks.resources.MONGODB_URI = undefined;
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('MONGODB_URI is not configured');

    mocks.resources.MONGODB_URI = 'mongodb://127.0.0.1:1/%STAGE%';
    mocks.stage = '';
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('needs a stage');
  });

  it('exits 2 on an unreachable host without echoing the URI', async () => {
    mocks.resources.MONGODB_URI = 'mongodb://user:hun@ter2@127.0.0.1:1/db';
    expect(await run([])).toBe(2);
    const message = err.join('\n');
    expect(message).toContain('Re-encrypt failed');
    expect(message).not.toMatch(/ter2|127\.0\.0\.1|hun/);
  });

  it('exits 2 for a database with no ciphertext', async () => {
    expect(await run([])).toBe(2);
    expect(err.join('\n')).toContain('wrong or empty database');
  });

  it('fills the stage into the URI', async () => {
    seed = await seedTable(cliDb(), subsetFields());
    mocks.resources.MONGODB_URI = uriFor('reencrypt_%STAGE%');
    mocks.stage = 'cli';
    expect(await run(['--verify'])).toBe(1);
    expect(out.join('\n')).toContain(`Database: ${dbName}`);
  });

  it('reads the keys and the URI from the environment when there is no SST resource', async () => {
    seed = await seedTable(cliDb(), subsetFields());
    mocks.resources = {};
    vi.stubEnv('MONGODB_URI', uriFor());
    vi.stubEnv('SECRET_ENCRYPTION_KEY', newKey);
    vi.stubEnv('SECRET_ENCRYPTION_KEY_PREVIOUS', oldKey);

    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);
    expectNoLeaks();
  });

  it('prefers the SST resource over the environment', async () => {
    seed = await seedTable(cliDb(), subsetFields());
    vi.stubEnv('SECRET_ENCRYPTION_KEY', otherKey);
    vi.stubEnv('SECRET_ENCRYPTION_KEY_PREVIOUS', otherKey);

    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);
  });

  it('rotates a seeded database, verifies it, and prints no key, value or document id', async () => {
    seed = await seedTable(cliDb(), subsetFields());
    const before = await snapshot(cliDb());

    expect(await run(['--verify'])).toBe(1);
    expect(await run(['--dry-run'])).toBe(0);
    expect(await snapshot(cliDb())).toEqual(before);

    expect(await run([])).toBe(0);
    expect(await run([])).toBe(0);
    expect(await run(['--verify'])).toBe(0);

    const text = output();
    expect(text).toContain(`Database: ${dbName}`);
    expect(text).toContain('Mode: ROTATE');
    expect(text).toContain('Mode: DRY RUN (no writes)');
    expect(text).toContain('Mode: VERIFY (current key only)');
    expectNoLeaks();

    const after = await snapshot(cliDb());
    for (const entry of seed.seeded) {
      if (entry.kind !== 'old') continue;
      const value = getAt(docOf(after, entry.collection, entry.id), entry.location) as string;
      expect(decryptSecret(value, newKey, entry.context), `${entry.label} ${entry.location}`).toBe(entry.plaintext);
    }
    const rotatedValues = seed.seeded
      .filter(entry => entry.kind === 'old')
      .map(entry => getAt(docOf(after, entry.collection, entry.id), entry.location) as string);
    for (const value of rotatedValues) expect(text).not.toContain(value);
  });
});
