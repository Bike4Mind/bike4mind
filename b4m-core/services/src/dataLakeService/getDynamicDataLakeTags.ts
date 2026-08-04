import {
  DATA_LAKES,
  DataLakeConfig,
  getAccessibleDataLakes,
  toDataLakeConfig,
  type IDataLakeRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import { buildDatalakeTag } from './createDataLake';

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
   * `id` is the owner bypass - the caller always retrieves their own lakes (re-checked in
   * memory against each lake's persisted `createdByUserId`, not assumed from the query), and a
   * gateless org-less lake is owner-only (Private-by-default). Both accept an ObjectId-like
   * value too (a hydrated user doc carries ObjectIds); they're string-coerced before querying.
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
 *
 * The DB pre-filter's owner bypass is honoured too: a lake the caller created resolves even
 * when they do not hold its own declared gate. Ownership is re-verified here against the
 * persisted `createdByUserId` rather than assumed from the query, and stays bounded by the
 * pre-filter's `status: 'active'`, so a caller's own DRAFT lake remains browse-only. The
 * bypass is org-independent, matching browse: a creator who has since moved orgs still reaches
 * a gated lake they made in the old one, and only they or an admin could have put files in it.
 */
export async function getDynamicDataLakeAccess(
  context: DataLakeAccessContext
): Promise<{ dataLakeTags: string[]; dataLakeTagPrefixes: string[]; scopedTagPrefixes: string[] }> {
  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  // Coerce to string: the lake's organizationId/createdByUserId are String fields, but a hydrated
  // user doc may carry an ObjectId - or a populated Organization document - here, and an
  // ObjectId/document query against a String never matches. normalizeId handles all three shapes;
  // plain String() would turn a populated doc into "[object Object]" (#1281 / @bike4mind/utils/normalizeId).
  const organizationId = normalizeId(context.user.organizationId);
  const userId = context.user.id ? String(context.user.id) : undefined;
  let dynamicDataLakes: DataLakeConfig[] | undefined;
  // Ids of fetched lakes whose PERSISTED createdByUserId is this caller. Read off the raw
  // documents because toDataLakeConfig drops createdByUserId - and that projection is also what
  // GET /api/data-lakes serializes to the browser, so the field must not be widened into
  // DataLakeConfig just to reach it here. Declared const and filled in place: it can only gain
  // members inside the try below, so an absent repo or a failed read leave it empty by
  // construction rather than by a reader's reasoning.
  const ownedDynamicIds = new Set<string>();
  if (context.db.dataLakes) {
    try {
      const dbLakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationId,
        userId
      );
      dynamicDataLakes = dbLakes.map(toDataLakeConfig);
      // Only the document side is coerced. `userId` is already a string or undefined, so an
      // id-less caller can never match: leave it uncoerced. Wrapping it too would compare the
      // literal 'undefined' and hand every lake whose creator is the string 'undefined' - a
      // plausible bad-ingest value - to every anonymous caller. The `if` is a cheap
      // short-circuit, not the guard.
      if (userId) {
        for (const dl of dbLakes) {
          if (String(dl.createdByUserId) === userId) ownedDynamicIds.add(dl.id);
        }
      }
    } catch (err) {
      // Degrading to the static registry silently looks exactly like "this deployment has no
      // dynamic lakes", so a read failure would quietly restore the pre-unification behavior.
      // Still non-fatal: the collection may simply not exist yet.
      context.logger?.warn('[dataLakes] dynamic lake lookup failed; falling back to the static registry', err);
    }
  }
  const accessibleLakes = getAccessibleDataLakes(userTags, dynamicDataLakes, entitlementKeys);
  // getAccessibleDataLakes is a pure tag/entitlement predicate with no ownership rule (by
  // design - its docstring tells callers to pre-filter), so on its own it discards a lake the
  // caller CREATED whose own gate they do not hold. The DB arm returned that lake via
  // `{ createdByUserId: userId }`; this puts it back.
  //
  // Do NOT reduce this to "the DB returned it, so the owner arm must have matched". The
  // in-memory pass is an independent second opinion whose job is to drop what an over-returning
  // query should not have handed us, so a NON-owned gated lake must still fall out even with a
  // userId present. That is why ownership is re-derived above from the persisted field.
  //
  // Every set below derives from this union, so the provenance split and the reserved-tag drop
  // apply to re-added lakes too.
  //
  // Restoring also requires the row to be well-formed: its meta-tag must be the one its own
  // slug/org would mint. Before this exemption a malformed row was dropped twice - by the gate
  // filter AND by the reserved-tag check - and the reserved-tag check knows only the registry
  // this runtime can see (the premium half arrives through an env seam). Requiring
  // self-consistency keeps a second, environment-independent check on the privileged path.
  const accessibleIds = new Set(accessibleLakes.map(dl => dl.id));
  const isWellFormed = (dl: DataLakeConfig) => dl.datalakeTag === buildDatalakeTag(dl.slug, dl.organizationId);
  const ownedGatedLakes = (dynamicDataLakes ?? []).filter(
    dl => ownedDynamicIds.has(dl.id) && !accessibleIds.has(dl.id) && isWellFormed(dl)
  );
  const resolvedLakes = [...accessibleLakes, ...ownedGatedLakes];
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
    dataLakeTags: resolvedLakes.filter(dl => !isShadowedRegistryTag(dl)).map(dl => dl.datalakeTag),
    dataLakeTagPrefixes: resolvedLakes.filter(dl => !dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
    scopedTagPrefixes: resolvedLakes.filter(dl => dynamicIds.has(dl.id)).map(dl => dl.fileTagPrefix),
  };
}
