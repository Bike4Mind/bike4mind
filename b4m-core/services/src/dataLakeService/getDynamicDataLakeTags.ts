import { DataLakeConfig, getAccessibleDataLakes, toDataLakeConfig, type IDataLakeRepository } from '@bike4mind/common';

/**
 * The minimal context the data-lake access resolver needs. Both the knowledge tools
 * (ToolContext) and the forced-retrieval feature (ChatCompletionContext) satisfy this
 * structurally, so this is the ONE shared resolver - no per-call-site duplicate.
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
}

/**
 * Fetches dynamic data lake configs from DB (if available) and returns
 * the merged datalake: tags for the user.
 *
 * Shared helper used by both knowledgeBaseSearch and knowledgeBaseRetrieve tools.
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
    } catch {
      // DB collection may not exist yet - fall through to hardcoded
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
  return {
    dataLakeTags: accessibleLakes.map(dl => dl.datalakeTag),
    dataLakeTagPrefixes: accessibleLakes.filter(dl => !dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    scopedTagPrefixes: accessibleLakes.filter(dl => dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
  };
}
