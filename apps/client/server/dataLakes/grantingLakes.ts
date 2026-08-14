import { DATA_LAKES, normalizeTagPrefix } from '@bike4mind/common';
import type { DataLakeConfig, IFabFileDocument } from '@bike4mind/common';

/**
 * Split out from `./index` on purpose: this file has NO dependency on the DB/entitlements chain
 * (`toAccessContext` -> `@server/entitlements` -> the Subscription model -> `@bike4mind/database`)
 * that the rest of the data-lakes barrel pulls in. A caller that only needs the pure
 * meta-tag/prefix predicate - notably a test asserting on the REAL implementation rather than a
 * reimplementation - can import it here without needing to mock that entire chain just to load
 * the module.
 */

export const STATIC_LAKE_IDS = new Set(DATA_LAKES.map(l => l.id));

/**
 * A lake's normalized file-tag prefix plus whether it's OPEN (static-registry) or SCOPED
 * (dynamic, user-controlled) - `undefined` if the lake has no usable prefix at all. The single
 * place this pairing is computed, shared by `grantingLakes` (per-lake, for naming a specific
 * grantor - only the open case is ever a grant on its own) and `splitTagPrefixes` in `./index.ts`
 * (aggregated, for scoping a browse/search query - both cases matter there). `splitTagPrefixes`'s
 * own doc comment already documents a past bug from two independent copies of prefix
 * normalization disagreeing; one copy is what keeps that from recurring here.
 */
export function normalizedLakePrefix(lake: DataLakeConfig): { prefix: string; isOpen: boolean } | undefined {
  const prefix = normalizeTagPrefix(lake.fileTagPrefix);
  if (!prefix) return undefined;
  return { prefix, isOpen: STATIC_LAKE_IDS.has(lake.id) };
}

/**
 * The specific lake(s) from `lakes` that grant a file carrying `fileTagNames` access: an exact
 * meta-tag match (covers dynamic lakes safely - membership IS the meta-tag) or a static-registry
 * (open) prefix match. A dynamic lake's user-controlled prefix is deliberately NOT a grant here -
 * that was the cross-tenant hole; dynamic-lake files are reached via the meta-tag only. Takes tag
 * NAMES rather than a file document - same calling convention as `attributeAccessedLakeIds` - so
 * both the full-document gate (`isFileInAccessibleLake`) and a caller holding only a tag list
 * (e.g. `queryDataLakeArticles`'s already-projected metadata) can share this one computation. That
 * sharing is the point: a prefix-granted read has no tag to reverse, so an attribution site using
 * a SEPARATE, looser computation than the gate risks over-attributing to every accessible lake
 * instead of the one that actually granted it. (#836)
 */
export function grantingLakes(lakes: DataLakeConfig[], fileTagNames: string[]): DataLakeConfig[] {
  return lakes.filter(lake => {
    if (fileTagNames.includes(lake.datalakeTag)) return true;
    // Open-prefix access is registry-only - a dynamic lake's prefix is never a grant, checked
    // per-lake rather than via an aggregated open-prefix list so two lakes that happen to share a
    // prefix string can never cross-attribute to one another.
    const normalized = normalizedLakePrefix(lake);
    return !!normalized && normalized.isOpen && fileTagNames.some(t => t.startsWith(normalized.prefix));
  });
}

/** Pure gate: is `file` accessible via any of `lakes`? See `grantingLakes` for the predicate. */
export function isFileInAccessibleLake(lakes: DataLakeConfig[], file: IFabFileDocument): boolean {
  return grantingLakes(lakes, file.tags?.map(t => t.name) ?? []).length > 0;
}
