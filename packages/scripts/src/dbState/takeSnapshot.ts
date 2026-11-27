import type { mongo } from 'mongoose';
import { toCanonical } from './canonicalJson';
import { describeError } from './describeError';
import { checkSchemaDrift, type DeclaredIndex } from './schemaDrift';
import {
  SNAPSHOT_FORMAT_VERSION,
  type CollectionEntry,
  type IndexEntry,
  type InvalidTtlFinding,
  type SearchIndexEntry,
  type SearchIndexListing,
  type Snapshot,
  type UndefinedScanMode,
  type UndefinedValues,
} from './snapshotSchema';
import { scanForUndefined } from './undefinedScan';

export type SnapshotOptions = {
  exactCounts: boolean;
  /** Indexes declared by the Mongoose schemas; null skips the schema check. */
  declaredIndexes: readonly DeclaredIndex[] | null;
  undefinedScan: UndefinedScanMode;
  scanTimeLimitMs: number;
  now?: () => Date;
};

const MAX_TTL_SECONDS = 2147483647;

const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const isValidTtl = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TTL_SECONDS;

/** Works on raw listIndexes output, before canonicalization turns NaN or Long into objects. */
export const findInvalidTtlIndexes = (
  collections: ReadonlyArray<{ name: string; indexes: ReadonlyArray<mongo.Document> }>
): InvalidTtlFinding[] =>
  collections.flatMap(collection =>
    collection.indexes
      .filter(index => 'expireAfterSeconds' in index && !isValidTtl(index.expireAfterSeconds))
      .map(index => ({
        collection: collection.name,
        index: String(index.name),
        expireAfterSeconds: toCanonical(index.expireAfterSeconds),
      }))
  );

const toIndexEntry = (spec: mongo.Document): IndexEntry => {
  const { key, name, ns: _ns, ...options } = spec;
  return {
    name: String(name),
    key: Object.entries(asRecord(key)).map(([field, direction]) => [field, toCanonical(direction)]),
    options: asRecord(toCanonical(options)),
  };
};

const readServer = async (db: mongo.Db): Promise<Snapshot['server']> => {
  const admin = db.admin();
  const buildInfo = await admin.command({ buildInfo: 1 });
  const hello = await admin.command({ hello: 1 });
  const listed = (field: string): number => (Array.isArray(hello[field]) ? hello[field].length : 0);
  return {
    version: String(buildInfo.version),
    replicaSetMembers:
      typeof hello.setName === 'string' ? listed('hosts') + listed('passives') + listed('arbiters') : null,
  };
};

const toSearchIndexEntry = (raw: mongo.Document): SearchIndexEntry => ({
  name: String(raw.name),
  type: typeof raw.type === 'string' ? raw.type : null,
  status: typeof raw.status === 'string' ? raw.status : null,
  queryable: typeof raw.queryable === 'boolean' ? raw.queryable : null,
  definition: toCanonical(raw.latestDefinition ?? null),
});

/** Servers without Atlas Search reject `$listSearchIndexes`; that is recorded, not raised. */
const readSearchIndexes = async (collection: mongo.Collection): Promise<SearchIndexListing> => {
  try {
    const raw = await collection.listSearchIndexes().toArray();
    return { supported: true, indexes: raw.map(toSearchIndexEntry).sort(byName) };
  } catch (error) {
    return { supported: false, reason: describeError(error) };
  }
};

const countOrNull = async (count: () => Promise<number>): Promise<number | null> => {
  try {
    return await count();
  } catch {
    return null;
  }
};

type RawCollection = { entry: CollectionEntry; rawIndexes: mongo.Document[] };

const readCollection = async (
  db: mongo.Db,
  info: mongo.CollectionInfo,
  exactCounts: boolean
): Promise<RawCollection> => {
  const collection = db.collection(info.name);
  const type = info.type ?? 'collection';
  const hasIndexes = type !== 'view';
  const rawIndexes = hasIndexes ? await collection.indexes() : [];
  return {
    rawIndexes,
    entry: {
      name: info.name,
      type,
      options: asRecord(toCanonical(info.options ?? {})),
      estimatedCount: hasIndexes ? await countOrNull(() => collection.estimatedDocumentCount()) : null,
      exactCount: hasIndexes && exactCounts ? await countOrNull(() => collection.countDocuments()) : null,
      indexes: rawIndexes.map(toIndexEntry).sort(byName),
      searchIndexes: await readSearchIndexes(collection),
    },
  };
};

const scanCollections = async (
  db: mongo.Db,
  collections: readonly CollectionEntry[],
  mode: 'top-level' | 'nested',
  timeLimitMs: number
): Promise<UndefinedValues> => {
  const found: UndefinedValues['collections'] = [];
  const unfinished: UndefinedValues['unfinished'] = [];
  for (const { name, type } of collections) {
    if (type === 'view') continue;
    const result = await scanForUndefined(db.collection(name), mode, timeLimitMs);
    if (result.status === 'incomplete') unfinished.push({ collection: name, reason: result.reason });
    else if (result.documents > 0) found.push({ collection: name, documents: result.documents });
  }
  return { mode, collections: found, unfinished };
};

/**
 * Reads the structural state of `db`. Sends only the commands in READ_ONLY_COMMANDS
 * (readOnlyGuard.ts); the integration test asserts that against the driver's command log.
 */
export const takeSnapshot = async (db: mongo.Db, options: SnapshotOptions): Promise<Snapshot> => {
  const takenAt = (options.now ?? (() => new Date()))().toISOString();
  const server = await readServer(db);
  const infos = (await db.listCollections().toArray())
    .filter(info => !info.name.startsWith('system.'))
    .sort(byName) as mongo.CollectionInfo[];

  const raw: RawCollection[] = [];
  for (const info of infos) raw.push(await readCollection(db, info, options.exactCounts));
  const collections = raw.map(item => item.entry);

  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    takenAt,
    database: db.databaseName,
    server,
    settings: {
      exactCounts: options.exactCounts,
      schemaCheck: options.declaredIndexes !== null,
      undefinedScan: options.undefinedScan,
    },
    collections,
    checks: {
      invalidTtl: findInvalidTtlIndexes(raw.map(item => ({ name: item.entry.name, indexes: item.rawIndexes }))),
      schemaDrift: options.declaredIndexes ? checkSchemaDrift(options.declaredIndexes, collections) : null,
      undefinedValues:
        options.undefinedScan === 'off'
          ? null
          : await scanCollections(db, collections, options.undefinedScan, options.scanTimeLimitMs),
    },
  };
};
