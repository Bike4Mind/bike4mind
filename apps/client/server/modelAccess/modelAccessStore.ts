import { AdminSettings, Cache, cacheRepository, withTransaction } from '@bike4mind/database';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { recordAdminSettingChange } from '@bike4mind/server-utils/utils/adminSettingsAudit';
import {
  ACCESS_SETTING_NAME,
  accessFieldsOf,
  indexEntries,
  toEntryDocument,
  type StoredAccessEntry,
} from './modelAccessEntries';

type AuditRequest = Parameters<typeof recordAdminSettingChange>[0];

export async function readAccessEntries(): Promise<Map<string, StoredAccessEntry>> {
  const doc = await AdminSettings.findOne({ settingName: ACCESS_SETTING_NAME }).lean();
  return indexEntries((doc as { settingValue?: unknown } | null)?.settingValue);
}

class StaleAccessEntryError extends Error {
  constructor() {
    super('access entry stamp moved');
    this.name = 'StaleAccessEntryError';
  }
}

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

/** Marks a dry-run token spent; true for the one caller that claims it. The row outlives the token it covers. */
export async function claimDryRun(jti: string, actor: string, ttlMs: number): Promise<boolean> {
  // autoIndex builds lazily; the unique key index must exist before two claims can race.
  await Cache.init();
  try {
    const { claimed } = await cacheRepository.claimDedup(`model-access-dry-run:${jti}`, { actor }, ttlMs);
    return claimed;
  } catch (error) {
    // A store that does not retry the racing upsert fails the loser with a duplicate key instead.
    if (isDuplicateKey(error)) return false;
    throw error;
  }
}

// The whole access list is one document, so each write reaches one entry by id and stamp. The stamp sits in
// the query filter: in arrayFilters alone a stale write still matches the document and reports matched 1.
// A null `expected` also matches an entry stored before stamps, which carries no updatedAt.
async function writeEntry(id: string, expected: Date | null, next: StoredAccessEntry | null): Promise<void> {
  const filter = { settingName: ACCESS_SETTING_NAME, settingValue: { $elemMatch: { id, updatedAt: expected } } };
  if (next === null) {
    const removed = await AdminSettings.updateOne(filter, { $pull: { settingValue: { id, updatedAt: expected } } });
    if (removed.matchedCount !== 1) throw new StaleAccessEntryError();
    return;
  }
  const updated = await AdminSettings.updateOne(
    filter,
    { $set: { 'settingValue.$[entry]': toEntryDocument(next) } },
    { arrayFilters: [{ 'entry.id': id, 'entry.updatedAt': expected }] }
  );
  if (updated.matchedCount === 1) return;
  if (expected !== null) throw new StaleAccessEntryError();
  // No entry yet. The upsert also creates the document on the first create; when the id already exists the
  // filter misses and the upsert collides on the unique settingName index.
  try {
    await AdminSettings.updateOne(
      { settingName: ACCESS_SETTING_NAME, 'settingValue.id': { $ne: id } },
      { $push: { settingValue: toEntryDocument(next) } },
      { upsert: true }
    );
  } catch (error) {
    if (isDuplicateKey(error)) throw new StaleAccessEntryError();
    throw error;
  }
}

export type AccessCommit = {
  id: string;
  /** The stamp the caller read; null when it read no entry or an unstamped one. */
  expected: Date | null;
  before: StoredAccessEntry | null;
  /** The entry to store; null removes it (undoing a create). */
  next: StoredAccessEntry | null;
  reason: string;
  details?: Record<string, unknown>;
};

/**
 * One conditional entry write plus its strict audit entry, in one transaction. Returns 'stale' when the
 * entry's stamp no longer matches `expected` (or a create found the id already present).
 */
export async function commitAccessEntry(req: AuditRequest, commit: AccessCommit): Promise<'written' | 'stale'> {
  const { id, expected, before, next, reason, details } = commit;
  // autoIndex builds lazily; without the unique settingName index a racing create would insert a second document.
  if (expected === null) await AdminSettings.init();
  try {
    await withTransaction(async () => {
      await writeEntry(id, expected, next);
      await recordAdminSettingChange(req, {
        settingName: ACCESS_SETTING_NAME,
        before: before ? accessFieldsOf(before) : null,
        after: next ? accessFieldsOf(next) : null,
        summary: next ? `updated access for model ${id}` : `removed the access entry for model ${id}`,
        target: { id: `${ACCESS_SETTING_NAME}:${id}`, displayName: `${id} access` },
        details: { modelId: id, ...details },
        reason,
      });
    });
  } catch (error) {
    if (error instanceof StaleAccessEntryError) return 'stale';
    throw error;
  }
  invalidateSettingsCache(ACCESS_SETTING_NAME);
  return 'written';
}
