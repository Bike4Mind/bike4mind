import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  toDataLakeConfig,
  type IDataLakeRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * The minimal context the data-lake access resolver needs. The knowledge tools
 * (ToolContext), the forced-retrieval feature (ChatCompletionContext), and the app-layer
 * semantic-search route (via server/dataLakes/resolveRetrievalLakeScope) all satisfy this
 * structurally, so this is the ONE shared resolver - no per-call-site duplicate.
 *
 * Non-goal: this resolver has NO admin/developer bypass and must not grow one. A privileged
 * widening here would reach every admin's chat session and pull other tenants' documents
 * into the model context. Surfaces that need one apply it outside, on their own result.
 */
export interface DataLakeAccessContext {
  db: {
    dataLakes?: Pick<IDataLakeRepository, 'findActiveByUserTags' | 'findActiveByUserTagsAndEntitlements'>;
  };
  /**
   * The caller. `organizationId` scopes org lakes (org-less lakes stay open to all);
   * `id` is the owner bypass - the caller always retrieves their own lakes, and a gateless
   * org-less lake is owner-only (Private-by-default). Both accept an ObjectId-like value too
   * (a hydrated user doc carries ObjectIds); they're string-coerced before querying.
   */
  user: {
    id?: string | { toString(): string } | null;
    tags?: string[] | null;
    organizationId?: string | { toString(): string } | null;
  };
  /** Caller's resolved entitlement keys; absent means tag-only matching. */
  entitlementKeys?: string[];
  /** Optional; only used to report a swallowed dataLakes read failure (see below). */
  logger?: Logger;
}

/**
 * Fetches dynamic data lake configs from DB (if available) and returns
 * the merged datalake: tags for the user.
 *
 * Tags-only convenience wrapper over getDynamicDataLakeAccess below. Currently has no
 * production callers - every retrieval surface needs the prefixes too and calls the full
 * resolver directly. Kept as part of the package's public surface.
 */
export async function getDynamicDataLakeTags(context: DataLakeAccessContext): Promise<string[]> {
  return (await getDynamicDataLakeAccess(context)).dataLakeTags;
}

/**
 * Returns BOTH the meta-tags AND the file tag prefixes for a user's accessible data lakes.
 * Use this for fabfiles.search() so files are matched by either the datalake:* meta-tag
 * (when present) OR by their content tag prefix (e.g. opti:*, acme:*) - many data lake
 * files don't have the meta-tag but do have the prefix-based content tags.
 *
 * Access is entitlement-aware: lakes are matched against the user's tags AND resolved
 * entitlement keys (any-of declared requirements), so an entitlement-gated lake resolves
 * for a tag-less subscriber. The same `entitlementKeys` flow to BOTH the DB pre-filter and
 * the in-memory filter so the meta-tag set and the prefix set stay consistent.
 */
export async function getDynamicDataLakeAccess(
  context: DataLakeAccessContext
): Promise<{ dataLakeTags: string[]; dataLakeTagPrefixes: string[]; scopedTagPrefixes: string[] }> {
  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  // Coerce to string: the lake's organizationId/createdByUserId are String fields, but a
  // hydrated user doc may carry ObjectIds here - an ObjectId query against a String never matches.
  const organizationId = context.user.organizationId ? String(context.user.organizationId) : undefined;
  const userId = context.user.id ? String(context.user.id) : undefined;
  let dynamicDataLakes: DataLakeConfig[] | undefined;
  if (context.db.dataLakes) {
    try {
      const dbLakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationId,
        userId
      );
      dynamicDataLakes = dbLakes.map(toDataLakeConfig);
    } catch (err) {
      // Degrading to the static registry silently looks exactly like "this deployment has no
      // dynamic lakes", so a read failure would quietly restore the pre-unification behavior.
      // Still non-fatal: the collection may simply not exist yet.
      context.logger?.warn('[dataLakes] dynamic lake lookup failed; falling back to the static registry', err);
    }
  }
  // Filter ONCE and derive every set from the single result (the meta-tags and the
  // prefixes are guaranteed consistent, and we avoid a redundant second filter pass).
  const accessibleLakes = getAccessibleDataLakes(userTags, dynamicDataLakes, entitlementKeys);
  // Split prefixes by provenance: static-registry lakes are OPEN (shared KB - ownership
  // bypass by design); dynamic (DB) lakes are SCOPED (their user-controlled prefix must be
  // matched ONLY within owner/org access, else a colliding prefix leaks another tenant's
  // files). A lake is dynamic iff it came from the DB set.
  const dynamicIds = new Set((dynamicDataLakes ?? []).map(d => d.id));
  // The meta-tag arm is an ownership bypass, safe only because a lake's datalakeTag is
  // globally unique. A DB row can still carry a tag the static registry owns (the registry
  // has no documents, so the unique index never saw the collision), and that row would hand
  // its creator every tenant's files in the registry lake. createDataLake now refuses to mint
  // such a tag; this drops any row that predates that guard or was written around it.
  const reservedTags = new Set(DATA_LAKES.map(lake => lake.datalakeTag));
  const isShadowedRegistryTag = (dl: DataLakeConfig) => dynamicIds.has(dl.id) && reservedTags.has(dl.datalakeTag);
  return {
    dataLakeTags: accessibleLakes.filter(dl => !isShadowedRegistryTag(dl)).map(dl => dl.datalakeTag),
    dataLakeTagPrefixes: accessibleLakes.filter(dl => !dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    scopedTagPrefixes: accessibleLakes.filter(dl => dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
  };
}
