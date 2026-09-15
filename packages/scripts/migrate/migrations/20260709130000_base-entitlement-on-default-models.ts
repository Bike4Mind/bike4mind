import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: grant the reserved `base` entitlement to base (default-seed) LLM model
 * configs so tag-less accounts (OAuth/SSO/admin-created) can see them.
 *
 * Background: `getDefaultModelConfig` historically seeded a model's `allowedUserTags`
 * with the predefined tag set as a "proxy for everyone" - so a base model was only
 * visible to a user holding one of those tags. Accounts created outside the OTC flow
 * get no tags and were therefore locked out of every model. The durable fix is the
 * reserved `base` entitlement, which `getUserEntitlements` grants to EVERY authenticated
 * user; a model reachable by all users declares `allowedEntitlements: ['base']`.
 *
 * This migration is ADDITIVE and deploy-safe (permissive-first): it only ADDS `base` to
 * the `allowedEntitlements` of configs whose `allowedUserTags` is exactly a known
 * default-seed set, and it KEEPS the tags. Existing tag-holding users keep access via the
 * tag throughout the rollout; tag-less users gain access via `base` once the new code is
 * live. It never removes a permissive value the old code relied on, so base models never
 * disappear mid-deploy.
 *
 * Scope guard: only configs whose tag set is exactly a historical default seed are
 * treated as "meant for everyone". A config with any custom tag, a subset, or an existing
 * entitlement gate is a deliberate restriction and is left untouched. Two seed sets are
 * matched: the current {developer, customer, opti} and the pre-2026-07-08 seed that also
 * carried {analyst}. NOTE this is a b4m/existing-doc cleanup only - fresh self-hosts have
 * no saved doc and get correct behavior from the code default (`getDefaultModelConfig`),
 * so correctness does not depend on this migration's run timing.
 *
 * Idempotent: a rewritten entry has a non-empty `allowedEntitlements`, which the filter
 * skips, so a re-run touches nothing.
 */

const BASE_ENTITLEMENT_KEY = 'base'; // keep in sync with apps/client/lib/entitlements/registry.ts

// Historical `getDefaultModelConfig` seed sets (lowercased), each meaning "everyone".
const DEFAULT_SEED_TAG_SETS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['developer', 'customer', 'opti']),
  new Set(['analyst', 'customer', 'developer', 'opti']),
];

const normalizeTagSet = (tags: unknown): Set<string> | null => {
  if (!Array.isArray(tags)) return null;
  return new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag.length > 0));
};

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every(value => b.has(value));

const matchesDefaultSeed = (tags: unknown): boolean => {
  const set = normalizeTagSet(tags);
  if (!set) return false;
  return DEFAULT_SEED_TAG_SETS.some(seed => setsEqual(set, seed));
};

const hasNonEmptyEntitlements = (entry: { allowedEntitlements?: unknown }): boolean =>
  Array.isArray(entry.allowedEntitlements) && entry.allowedEntitlements.length > 0;

const migration: MigrationFile = {
  id: 20260709130000,
  name: 'base-entitlement-on-default-models',

  up: async () => {
    const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
    if (!setting) {
      console.log('[base-entitlement-on-default-models] no llmModelConfigurations doc - nothing to do');
      return;
    }

    const configs = setting.settingValue;
    if (!Array.isArray(configs)) {
      console.log('[base-entitlement-on-default-models] settingValue is not an array - nothing to do');
      return;
    }

    let matched = 0;
    for (const entry of configs) {
      if (!entry || typeof entry !== 'object') continue;
      if (hasNonEmptyEntitlements(entry)) continue; // deliberate entitlement gate or already migrated
      if (!matchesDefaultSeed(entry.allowedUserTags)) continue;
      entry.allowedEntitlements = [BASE_ENTITLEMENT_KEY]; // keep allowedUserTags (deploy-safe, additive)
      matched++;
    }

    console.log(
      `[base-entitlement-on-default-models] ${configs.length} configs total, ${matched} default-seed configs granted '${BASE_ENTITLEMENT_KEY}'`
    );

    if (matched > 0) {
      await AdminSettings.updateOne({ _id: setting._id }, { settingValue: configs });
    }
  },

  down: async () => {
    const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
    if (!setting || !Array.isArray(setting.settingValue)) return;

    const configs = setting.settingValue;
    let reverted = 0;
    for (const entry of configs) {
      if (!entry || typeof entry !== 'object') continue;
      // Reverse only what up() created: a default-seed config whose entitlements are
      // exactly ['base']. Leaves genuinely entitlement-gated configs untouched.
      const ents = entry.allowedEntitlements;
      const isExactlyBase = Array.isArray(ents) && ents.length === 1 && ents[0] === BASE_ENTITLEMENT_KEY;
      if (isExactlyBase && matchesDefaultSeed(entry.allowedUserTags)) {
        delete entry.allowedEntitlements;
        reverted++;
      }
    }

    if (reverted > 0) {
      await AdminSettings.updateOne({ _id: setting._id }, { settingValue: configs });
    }
  },
};

export default migration;
