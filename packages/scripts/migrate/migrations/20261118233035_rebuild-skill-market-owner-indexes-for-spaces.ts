import mongoose from 'mongoose';
import { SkillBundle, SkillListing } from '@bike4mind/database';
import type { MigrationFile } from './index';

type IndexShape = {
  name: string;
  oldKey: Record<string, 1>;
  newKey: Record<string, 1>;
  partialFilterExpression?: Record<string, unknown>;
};

type Collection = typeof SkillListing.collection;

// Rebuilt under the same names so a pre-deploy instance's autoIndex hits a name conflict instead of
// recreating the old key.
const REBUILT: Array<{ collection: Collection; shape: IndexShape }> = [
  {
    collection: SkillListing.collection,
    shape: {
      name: 'skill_listing_claude_plugin_name',
      oldKey: { organizationId: 1, claudePluginName: 1 },
      newKey: { organizationId: 1, spaceId: 1, claudePluginName: 1 },
      partialFilterExpression: { claudePluginName: { $type: 'string' } },
    },
  },
  {
    collection: SkillBundle.collection as unknown as Collection,
    shape: {
      name: 'organizationId_1_pluginName_1',
      oldKey: { organizationId: 1, pluginName: 1 },
      newKey: { organizationId: 1, spaceId: 1, pluginName: 1 },
    },
  },
];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const hasOldOptions = (index: Record<string, unknown>, partial: Record<string, unknown> | undefined) =>
  index.unique === true &&
  sameJson(index.partialFilterExpression, partial) &&
  index.sparse !== true &&
  index.collation === undefined &&
  index.expireAfterSeconds === undefined &&
  index.hidden !== true;

async function rebuild(collection: Collection, shape: IndexShape): Promise<void> {
  // A fresh database has no collection yet; createIndex below creates it.
  const indexes = await collection.indexes().catch(error => {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 26) throw error;
    return [];
  });
  const existing = indexes.find(index => index.name === shape.name);
  if (existing && sameJson(existing.key, shape.newKey)) return;
  if (existing) {
    if (!sameJson(existing.key, shape.oldKey) || !hasOldOptions(existing, shape.partialFilterExpression)) {
      throw new Error(`Refusing to replace an unrecognized index: ${shape.name}`);
    }
    try {
      await collection.dropIndex(shape.name);
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
    }
  }
  await collection.createIndex(shape.newKey, {
    name: shape.name,
    unique: true,
    ...(shape.partialFilterExpression ? { partialFilterExpression: shape.partialFilterExpression } : {}),
  });
}

const migration: MigrationFile = {
  id: 20261118233035,
  name: 'rebuild skill market owner indexes for spaces',
  up: async () => {
    for (const { collection, shape } of REBUILT) await rebuild(collection, shape);
    await SkillListing.collection.createIndex(
      { status: 1, visibility: 1, spaceId: 1 },
      { name: 'skill_listing_status_visibility_space', partialFilterExpression: { spaceId: { $exists: true } } }
    );
  },
  // The old keys cannot tell Space-owned rows apart, so they are not restored.
  down: async () => {},
};
export default migration;
