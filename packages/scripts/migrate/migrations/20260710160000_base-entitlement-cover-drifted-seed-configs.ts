import { AdminSettings } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: extend the reserved `base` entitlement to default-seed LLM model configs
 * whose `allowedUserTags` DRIFTED away from the exact seed sets the first pass matched -
 * WITHOUT opening any model a baseline user could not already see.
 *
 * Background: `20260709130000_base-entitlement-on-default-models` granted `base` only to
 * configs whose tag set was EXACTLY `{developer,customer,opti}` or
 * `{analyst,customer,developer,opti}`. That covered environments seeded with the current
 * default, but long-lived installs accumulated configs seeded by OLDER generations of
 * `getDefaultModelConfig` (before `opti` was added, while `analyst` still existed) - e.g.
 * `{analyst,customer,developer}`, `{customer,developer}`, `{customer}`. None matched the
 * exact-seed guard, so those models stayed tag-only gated and remained invisible to
 * tag-less (OAuth/SSO/admin-created) accounts even after the fix shipped.
 *
 * Match rule - anchored on `customer`, the historical "everyone" baseline tag. Every
 * `getDefaultModelConfig` seed has always included `customer`, so a config that still
 * carries `customer` (alongside only other predefined tags) is a drifted default seen by
 * baseline users; a config from which `customer` was REMOVED (e.g. `{developer}` only) is a
 * deliberate operator restriction that baseline users never saw. Grant `base` iff:
 *   (a) NO existing `allowedEntitlements` (empty/absent), AND
 *   (b) `allowedUserTags` is NON-EMPTY, contains `customer`, and every tag is in the
 *       predefined "audience" universe {analyst, customer, developer, opti}.
 * This makes a tag-less account see exactly what a baseline `customer`-tagged user already
 * sees - no more. A `{developer}`-only (or otherwise customer-less) gate, a custom tag, or
 * an existing entitlement gate is left untouched, so no deliberately restricted model - on
 * B4M prod OR a self-host install - is ever made public by this migration.
 *
 * ADDITIVE and deploy-safe: `base` is ADDED, `allowedUserTags` is KEPT, so tag-holders are
 * unaffected and no permissive value the old code relied on is removed. Idempotent: a config
 * that already carries any entitlement (including the `['base']` from the first pass) is
 * skipped, so a re-run is a no-op. Fresh installs need no migration - the code default
 * (`getDefaultModelConfig`) already seeds `allowedEntitlements: ['base']`.
 *
 * Superset note: this pass re-covers the first pass's matches (both exact seed sets contain
 * `customer`), but those already carry `['base']` and are skipped by the entitlement guard,
 * so there is no double-write.
 */

const BASE_ENTITLEMENT_KEY = 'base'; // keep in sync with apps/client/lib/entitlements/registry.ts
const BASELINE_TAG = 'customer'; // the historical "everyone" tag every default seed carried

// Historical `getDefaultModelConfig` "audience" tag universe (lowercased). `analyst` is
// included because pre-2026-07-08 seeds carried it; `opti` because current seeds do.
const PREDEFINED_AUDIENCE_TAGS: ReadonlySet<string> = new Set(['analyst', 'customer', 'developer', 'opti']);

const normalizeTagSet = (tags: unknown): Set<string> | null => {
  if (!Array.isArray(tags)) return null;
  return new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag.length > 0));
};

// True iff tags is a drifted default seed: non-empty, contains the baseline `customer` tag,
// and draws only from the predefined audience universe (no custom tag). A customer-less set
// (e.g. `{developer}`) is a deliberate restriction and returns false.
const isBaselineCustomerSeed = (tags: unknown): boolean => {
  const set = normalizeTagSet(tags);
  if (!set || set.size === 0 || !set.has(BASELINE_TAG)) return false;
  return [...set].every(tag => PREDEFINED_AUDIENCE_TAGS.has(tag));
};

const hasNonEmptyEntitlements = (entry: { allowedEntitlements?: unknown }): boolean =>
  Array.isArray(entry.allowedEntitlements) && entry.allowedEntitlements.length > 0;

const migration: MigrationFile = {
  id: 20260710160000,
  name: 'base-entitlement-cover-drifted-seed-configs',

  up: async () => {
    const setting = await AdminSettings.findOne({ settingName: 'llmModelConfigurations' });
    if (!setting) {
      console.log('[base-entitlement-cover-drifted-seed-configs] no llmModelConfigurations doc - nothing to do');
      return;
    }

    const configs = setting.settingValue;
    if (!Array.isArray(configs)) {
      console.log('[base-entitlement-cover-drifted-seed-configs] settingValue is not an array - nothing to do');
      return;
    }

    let matched = 0;
    for (const entry of configs) {
      if (!entry || typeof entry !== 'object') continue;
      if (hasNonEmptyEntitlements(entry)) continue; // entitlement gate or already migrated - never touch
      if (!isBaselineCustomerSeed(entry.allowedUserTags)) continue; // customer-less / custom / empty - leave as-is
      entry.allowedEntitlements = [BASE_ENTITLEMENT_KEY]; // keep allowedUserTags (deploy-safe, additive)
      matched++;
    }

    console.log(
      `[base-entitlement-cover-drifted-seed-configs] ${configs.length} configs total, ${matched} drifted default-seed configs granted '${BASE_ENTITLEMENT_KEY}'`
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
      // Reverse only what up() created: a baseline-customer seed whose entitlements are
      // exactly ['base']. Leaves genuinely entitlement-gated configs untouched. This also
      // reverts the first pass's writes for configs in this superset, which is acceptable -
      // both passes express the same "default seed -> base" intent.
      const ents = entry.allowedEntitlements;
      const isExactlyBase = Array.isArray(ents) && ents.length === 1 && ents[0] === BASE_ENTITLEMENT_KEY;
      if (isExactlyBase && isBaselineCustomerSeed(entry.allowedUserTags)) {
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
