import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import { SkillBundle, SkillListing } from '@bike4mind/database';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../database/src/__test__/createMongoServer';
import migration from './20261118233035_rebuild-skill-market-owner-indexes-for-spaces';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;

const listingName = 'skill_listing_claude_plugin_name';
const bundleName = 'organizationId_1_pluginName_1';
const spaceIndexName = 'skill_listing_status_visibility_space';

const oldListingKey = { organizationId: 1, claudePluginName: 1 };
const oldListingOptions = {
  name: listingName,
  unique: true,
  partialFilterExpression: { claudePluginName: { $type: 'string' } },
} as const;
const oldBundleKey = { organizationId: 1, pluginName: 1 };
const oldBundleOptions = { name: bundleName, unique: true } as const;

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

const dropIfPresent = (collection: { drop: () => Promise<unknown> }) =>
  collection.drop().catch(error => {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
  });

beforeEach(async () => {
  vi.restoreAllMocks();
  await dropIfPresent(SkillListing.collection);
  await dropIfPresent(SkillBundle.collection);
});

const indexOf = async (collection: typeof SkillListing.collection, name: string) =>
  (await collection.indexes()).find(index => index.name === name);

const seedOldIndexes = async () => {
  await SkillListing.collection.createIndex(oldListingKey, oldListingOptions);
  await SkillBundle.collection.createIndex(oldBundleKey, oldBundleOptions);
};

it('replaces the old shape under the same names and adds the Space index', async () => {
  await seedOldIndexes();

  await migration.up();

  expect((await indexOf(SkillListing.collection, listingName))?.key).toEqual({
    organizationId: 1,
    spaceId: 1,
    claudePluginName: 1,
  });
  expect(await indexOf(SkillListing.collection, listingName)).toMatchObject({
    unique: true,
    partialFilterExpression: { claudePluginName: { $type: 'string' } },
  });
  const bundle = await indexOf(SkillBundle.collection as unknown as typeof SkillListing.collection, bundleName);
  expect(bundle).toMatchObject({ key: { organizationId: 1, spaceId: 1, pluginName: 1 }, unique: true });
  expect(await indexOf(SkillListing.collection, spaceIndexName)).toMatchObject({
    key: { status: 1, visibility: 1, spaceId: 1 },
    partialFilterExpression: { spaceId: { $exists: true } },
  });
});

it('lets two Spaces and an org share a plugin name once rebuilt', async () => {
  await seedOldIndexes();
  await migration.up();
  const doc = (owner: Record<string, string>) => ({ ...owner, claudePluginName: 'review-pr' });
  await SkillListing.collection.insertOne(doc({ organizationId: 'org1' }));
  await SkillListing.collection.insertOne(doc({ spaceId: 'space1' }));
  await SkillListing.collection.insertOne(doc({ spaceId: 'space2' }));
  await expect(SkillListing.collection.insertOne(doc({ spaceId: 'space1' }))).rejects.toMatchObject({ code: 11000 });
  await expect(SkillListing.collection.insertOne(doc({ organizationId: 'org1' }))).rejects.toMatchObject({
    code: 11000,
  });
});

it('is a no-op on the second run', async () => {
  await seedOldIndexes();
  await migration.up();
  const before = await SkillListing.collection.indexes();
  const drop = vi.spyOn(SkillListing.collection, 'dropIndex');
  await expect(migration.up()).resolves.toBeUndefined();
  expect(drop).not.toHaveBeenCalled();
  expect(await SkillListing.collection.indexes()).toEqual(before);
});

it('creates the indexes when the old ones are absent', async () => {
  await migration.up();
  expect((await indexOf(SkillListing.collection, listingName))?.key).toEqual({
    organizationId: 1,
    spaceId: 1,
    claudePluginName: 1,
  });
});

it.each([
  ['a different key order', { claudePluginName: 1, organizationId: 1 }, oldListingOptions],
  [
    'a non-unique index',
    oldListingKey,
    { name: listingName, partialFilterExpression: { claudePluginName: { $type: 'string' } } },
  ],
  ['a missing partial filter', oldListingKey, { name: listingName, unique: true }],
  ['a collated index', oldListingKey, { ...oldListingOptions, collation: { locale: 'en' } }],
])('refuses a same-named index with %s and leaves it alone', async (_label, key, options) => {
  await SkillListing.collection.createIndex(key, options);
  const before = await SkillListing.collection.indexes();
  const drop = vi.spyOn(SkillListing.collection, 'dropIndex');
  await expect(migration.up()).rejects.toThrow('Refusing to replace an unrecognized index');
  expect(drop).not.toHaveBeenCalled();
  expect(await SkillListing.collection.indexes()).toEqual(before);
});

it('tolerates only an index-not-found race on drop', async () => {
  await seedOldIndexes();
  const drop = SkillListing.collection.dropIndex.bind(SkillListing.collection);
  vi.spyOn(SkillListing.collection, 'dropIndex').mockImplementationOnce(async name => {
    await drop(name);
    throw new mongoose.mongo.MongoServerError({ message: 'already dropped concurrently', code: 27 });
  });
  await expect(migration.up()).resolves.toBeUndefined();
  expect((await indexOf(SkillListing.collection, listingName))?.key).toHaveProperty('spaceId');
});

it('propagates unexpected drop failures', async () => {
  await seedOldIndexes();
  const failure = new mongoose.mongo.MongoServerError({ message: 'permission denied', code: 13 });
  vi.spyOn(SkillListing.collection, 'dropIndex').mockRejectedValueOnce(failure);
  await expect(migration.up()).rejects.toBe(failure);
});

it.each([
  ['listing', SkillListing.collection, oldListingKey, oldListingOptions, listingName],
  [
    'bundle',
    SkillBundle.collection as unknown as typeof SkillListing.collection,
    oldBundleKey,
    oldBundleOptions,
    bundleName,
  ],
])(
  'rejects an old-shape createIndex under the same %s name and builds nothing',
  async (_label, collection, key, options, name) => {
    await seedOldIndexes();
    await migration.up();
    const before = await collection.indexes();

    const error = await collection.createIndex(key, options).then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(mongoose.mongo.MongoServerError);
    console.info(`[same-name conflict] ${name}: code=${(error as { code?: number }).code}`);
    expect([85, 86]).toContain((error as { code: number }).code);
    expect(await collection.indexes()).toEqual(before);
  }
);

it('surfaces an old-schema Mongoose autoIndex conflict as a rejected init, not a crash', async () => {
  await seedOldIndexes();
  await migration.up();
  const before = await SkillListing.collection.indexes();

  const OldListingSchema = new Schema(
    { organizationId: String, claudePluginName: String },
    { collection: 'skill_listings', autoIndex: true }
  );
  OldListingSchema.index(oldListingKey, oldListingOptions);
  const OldListing = mongoose.model('OldShapeSkillListing', OldListingSchema);
  const indexEvent = new Promise<unknown>(resolve => OldListing.on('index', resolve));

  const initError = await OldListing.init().then(
    () => null,
    (e: unknown) => e
  );
  const eventError = await indexEvent;

  console.info(
    `[mongoose autoIndex] init rejected=${Boolean(initError)} code=${(initError as { code?: number } | null)?.code}; ` +
      `index event error=${Boolean(eventError)} code=${(eventError as { code?: number } | null)?.code}`
  );
  expect(initError ?? eventError).toBeInstanceOf(mongoose.mongo.MongoServerError);
  expect(await SkillListing.collection.indexes()).toEqual(before);
});

it('raises no unhandled rejection when nobody listens to an old-schema autoIndex conflict', async () => {
  await seedOldIndexes();
  await migration.up();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const OldSchema = new Schema(
      { organizationId: String, claudePluginName: String },
      { collection: 'skill_listings' }
    );
    OldSchema.index(oldListingKey, oldListingOptions);
    const OldListing = mongoose.model('OldShapeSkillListingUnobserved', OldSchema);
    await OldListing.init().catch(() => undefined);
    await new Promise(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
});
