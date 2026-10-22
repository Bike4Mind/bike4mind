import { AdminAuditLogModel, SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES } from '@bike4mind/database';
import { type MigrationFile } from './index';

const NAMESPACE_NOT_FOUND = 26;

const isNamespaceNotFound = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === NAMESPACE_NOT_FOUND;

const listExistingIndexNames = async (): Promise<string[]> => {
  try {
    const indexes = await AdminAuditLogModel.collection.listIndexes().toArray();
    return indexes.map(index => String(index.name));
  } catch (error) {
    // The collection is created lazily; nothing to drop before the first write.
    if (isNamespaceNotFound(error)) return [];
    throw error;
  }
};

/**
 * Replace the AdminAuditLog indexes with the `_id`-suffixed keyset set. The new indexes are built
 * before the superseded ones are dropped, so no filtered list query is left without a supporting
 * index. Drops are explicit (not syncIndexes) so only the named indexes are removed; `autoIndex` is
 * off in the deployed environments, so createIndexes must run here. Idempotent.
 */
const migration: MigrationFile = {
  id: 20260921235942,
  name: 'ensure adminauditlog read indexes',

  up: async () => {
    const existing = new Set(await listExistingIndexNames());
    await AdminAuditLogModel.createIndexes();
    for (const name of SUPERSEDED_ADMIN_AUDIT_INDEX_NAMES) {
      if (existing.has(name)) await AdminAuditLogModel.collection.dropIndex(name);
    }
  },

  down: async () => {
    // One-way: the superseded indexes are unused and the audit log is append-only.
  },
};

export default migration;
