import type { Model } from 'mongoose';

/**
 * Bring a TTL index's expireAfterSeconds to `retentionSeconds`, then build the model's declared indexes.
 * Shared by the *-audit-log-retention migrations.
 *
 * Mongo never applies a changed expireAfterSeconds to an existing index, and createIndexes with the
 * new value fails with IndexOptionsConflict, so an environment built with an older TTL keeps deleting
 * rows on the old schedule until the index is collMod-ed. collMod targets the key pattern rather than
 * the index name because the name is not guaranteed.
 *
 * Idempotent: collMod runs only when the stored TTL differs, and createIndexes is a no-op for indexes
 * that already match. It also builds the declared indexes where the collection has none.
 */
export async function setTtlIndexRetention<T>(
  model: Model<T>,
  keyPattern: Record<string, 1>,
  retentionSeconds: number
): Promise<void> {
  const collection = model.collection;
  const db = model.db.db;
  if (!db) throw new Error(`No database handle on ${model.modelName}; is mongoose connected?`);

  const collectionExists = (await db.listCollections({ name: collection.collectionName }).toArray()).length > 0;
  if (collectionExists) {
    const ttlIndex = (await collection.indexes()).find(
      index => JSON.stringify(index.key) === JSON.stringify(keyPattern)
    );
    if (ttlIndex && ttlIndex.expireAfterSeconds !== retentionSeconds) {
      await db.command({
        collMod: collection.collectionName,
        index: { keyPattern, expireAfterSeconds: retentionSeconds },
      });
    }
  }

  await model.createIndexes();
}
