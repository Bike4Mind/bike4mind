import { SLACK_AUDIT_LOG_RETENTION_SECONDS, SlackAuditLogModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Raise the Slack audit log TTL on createdAt to SLACK_AUDIT_LOG_RETENTION_SECONDS (12 months).
 *
 * Mongo never applies a changed expireAfterSeconds to an existing index, and createIndexes with the
 * new value fails with IndexOptionsConflict, so an environment built with the old 90-day TTL keeps
 * deleting rows at 90 days until the index is collMod-ed. collMod targets the key pattern rather
 * than the index name because prod runs DocumentDB.
 *
 * Idempotent: collMod runs only when the stored TTL differs, and createIndexes is a no-op for
 * indexes that already match. It also builds the declared indexes where the collection has none.
 */
const TTL_KEY = { createdAt: 1 };

const migration: MigrationFile = {
  id: 20260921235952,
  name: 'set Slack audit log retention to 12 months',

  up: async () => {
    const collection = SlackAuditLogModel.collection;
    const db = SlackAuditLogModel.db.db;
    if (!db) throw new Error('No database handle on SlackAuditLogModel; is mongoose connected?');

    const collectionExists = (await db.listCollections({ name: collection.collectionName }).toArray()).length > 0;
    if (collectionExists) {
      const ttlIndex = (await collection.indexes()).find(
        index => JSON.stringify(index.key) === JSON.stringify(TTL_KEY)
      );
      if (ttlIndex && ttlIndex.expireAfterSeconds !== SLACK_AUDIT_LOG_RETENTION_SECONDS) {
        await db.command({
          collMod: collection.collectionName,
          index: { keyPattern: TTL_KEY, expireAfterSeconds: SLACK_AUDIT_LOG_RETENTION_SECONDS },
        });
      }
    }

    await SlackAuditLogModel.createIndexes();
  },

  down: async () => {
    // One-way. Shortening the TTL would immediately delete up to nine months of audit history.
  },
};

export default migration;
