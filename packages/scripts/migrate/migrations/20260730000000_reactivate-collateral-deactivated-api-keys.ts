import { ApiKey } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: reactivate BYOK provider keys that were deactivated as collateral damage.
 *
 * createApiKey used to deactivate a user's keys by user id alone, with no type filter, so
 * adding a key for one provider silently deactivated the user's keys for every other
 * provider. Those users kept seeing the key on their account while every request for that
 * provider quietly resolved to the org demo key instead. The service now scopes the
 * deactivation by type, but the fix does not reach rows already written.
 *
 * LIMITATION: a group with no active key is indistinguishable from a user who deleted their
 * own active key and left an older one behind. Both resolve to "use the key the user actually
 * registered rather than the org demo key", which is the safer of the two outcomes, so this
 * treats them the same.
 *
 * Idempotent: a second run finds every group already has an active key and matches nothing.
 */

type ApiKeyLean = {
  _id: unknown;
  userId: string;
  type: string;
  isActive: boolean;
  expiresAt?: Date | null;
  createdAt?: Date | null;
};

const groupKey = (key: ApiKeyLean) => `${key.userId}|${key.type}`;
const time = (date?: Date | null) => (date ? date.getTime() : 0);

/**
 * Picks one key id per (userId, type) group that has no active key: the newest non-expired
 * one. Exported so the selection rules are testable without a database.
 *
 * Expired keys are deliberately NOT candidates. getEffectiveLLMApiKeys resolves a provider as
 * `keyOrExpired(userKey) || demoKey || envKey(...)`, and keyOrExpired returns the truthy string
 * 'expired' for an active-but-expired key - which short-circuits the demo-key fallback.
 * Activating an expired key would turn a silent fallback into an outright failure, so a group
 * whose only inactive keys are expired is left alone.
 *
 * A missing expiresAt counts as non-expired, matching keyOrExpired's own falsy check (rows
 * predating the expiration backfill can still lack the field).
 */
export const selectKeysToReactivate = (keys: ApiKeyLean[], now: Date): unknown[] => {
  const groups = new Map<string, ApiKeyLean[]>();
  for (const key of keys) {
    const group = groups.get(groupKey(key));
    if (group) group.push(key);
    else groups.set(groupKey(key), [key]);
  }

  const reactivate: unknown[] = [];
  for (const group of groups.values()) {
    if (group.some(key => key.isActive)) continue;

    const candidates = group.filter(key => !key.expiresAt || key.expiresAt > now);
    if (candidates.length === 0) continue;

    // Sorting on _id as well keeps the pick deterministic when createdAt ties, since
    // Mongo returns no guaranteed order.
    candidates.sort((a, b) => time(b.createdAt) - time(a.createdAt) || String(b._id).localeCompare(String(a._id)));
    reactivate.push(candidates[0]._id);
  }

  return reactivate;
};

const migration: MigrationFile = {
  id: 20260730000000,
  name: 'reactivate-collateral-deactivated-api-keys',

  up: async () => {
    // A group with no active key holds at least one inactive key, so narrowing the read to
    // those owners cannot miss a group. Their full key set is still needed to tell whether
    // the group has an active key at all.
    const ownerIds: string[] = await ApiKey.distinct('userId', { deletedAt: null, isActive: false });
    if (ownerIds.length === 0) {
      console.log('[reactivate-collateral-deactivated-api-keys] no inactive keys, nothing to do');
      return;
    }

    const keys = (await ApiKey.find({ deletedAt: null, userId: { $in: ownerIds } })
      .select('userId type isActive expiresAt createdAt')
      .lean()) as unknown as ApiKeyLean[];

    const ids = selectKeysToReactivate(keys, new Date());
    if (ids.length === 0) {
      console.log('[reactivate-collateral-deactivated-api-keys] every provider already has an active key');
      return;
    }

    const result = await ApiKey.updateMany({ _id: { $in: ids } }, { $set: { isActive: true } });
    console.log(
      `[reactivate-collateral-deactivated-api-keys] reactivated ${result.modifiedCount} stranded provider key(s)`
    );
  },

  // Irreversible: the bug destroyed the record of which keys the user meant to leave inactive,
  // so deactivating them again would just recreate the symptom.
  down: async () => {},
};

export default migration;
