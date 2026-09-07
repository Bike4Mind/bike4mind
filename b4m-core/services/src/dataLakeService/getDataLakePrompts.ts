import { DATA_LAKES, DATALAKE_TAG_PREFIX, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import type { DataLakeConfig, IDataLakeDocument } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import type { DataLakeAccessContext } from './getDynamicDataLakeTags';

/**
 * The distinct `datalake:*` provenance tags among a bag of file tag names - i.e. which lakes a set
 * of retrieved files belongs to. Feeds `restrictToDatalakeTags` so an injection site scopes to the
 * lakes a turn ACTUALLY used. Order-independent; deduped.
 *
 * Each returned value is a WHOLE `datalakeTag` (a file carries its lake's `datalakeTag` verbatim,
 * see buildDatalakeTag). `restrictToDatalakeTags` then matches these EXACTLY, never as a prefix -
 * so this scoping cannot over-match a sibling lake whose tag shares a prefix.
 */
export function datalakeTagsFrom(tagNames: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const name of tagNames) if (name.startsWith(DATALAKE_TAG_PREFIX)) out.add(name);
  return [...out];
}

/** A trusted lake's prompt, ready to render as a labeled block. */
export interface DataLakePrompt {
  /** Carried only as the sort tie-break - lake names are not unique (only `slug` is, per org). */
  id: string;
  name: string;
  systemPrompt: string;
}

/**
 * Trust rule for prompt INJECTION - deliberately narrower than read access.
 *
 * Read access has a public arm that crosses org boundaries by design (see
 * findActiveByUserTagsAndEntitlements), so "accessible" includes lakes published by
 * strangers in other orgs. Injecting those prompts would let any publisher put system
 * instructions into an unrelated user's turn - and the prompt text is editor-only, so
 * neither the user nor their org admin could see what is steering the answer. Content
 * from a stranger's public lake is still retrievable; only its INSTRUCTIONS are dropped.
 *
 * Trusted = the caller's own lake, or a lake scoped to one of the caller's orgs (the org admin
 * governance path - membership, not the selected-org pointer, #1674). The surviving lakes are
 * rendered by renderDataLakePromptSection at each retrieval-scoped injection site (forced
 * retrieval + the model-driven knowledge tools).
 *
 * UNCHANGED to also gate a STATIC (registry) lake's overlay `systemPrompt` (see
 * IFallbackLakeSetting) - deliberately not widened, on purpose, and not a separate function: a
 * registry lake's synthetic shape always carries `createdByUserId: ''`, so the owner arm above can
 * never fire for one (the truthiness guard), leaving only the org arm - exactly the deliberate
 * scope decided for registry-lake injection. A GATELESS/global registry lake (no organizationId,
 * the common case - e.g. a curated public knowledge base) therefore NEVER gets its systemPrompt
 * injected, no matter what an admin sets: unbounded platform-wide injection from one admin action
 * was considered and rejected as a materially larger blast radius than anything this rule already
 * allows (a DB lake's trust never reaches beyond one org either). The value is still stored and
 * editable regardless of scope (see updateFallbackLakeSettings) - this is the ONLY gate on whether
 * it is ever read into a turn.
 *
 * NOTE (#1668): the owner arm keys on `createdByUserId`, so a lake whose ownership was TRANSFERRED to
 * a new user (an owner grant supersedes the creator for management, but createdByUserId is immutable)
 * is not injection-trusted for that new owner unless the org arm covers it. Folding grants into this
 * READ-time trust decision is #1673's job (read-time grant resolution, with its report-only cutover);
 * wiring the grant repo through the ChatCompletion db here for that narrow edge is deliberately
 * deferred. Org-scoped lakes - the productization case - are covered by the org arm regardless.
 *
 * The lake side is normalized through normalizeId (which yields undefined for an absent value, so
 * it never becomes the string "undefined"). The schema stores this as a String today, but an
 * ObjectId- or populated-document org would fail the membership-set `includes` SILENTLY - denying
 * injection with no error - which is the hard failure mode to notice (#1281 / @bike4mind/utils/normalizeId).
 * The actor side needs no such normalization: `organizationIds` is already a set of plain strings
 * by contract (resolved via `IOrganizationRepository.findMembershipOrgIds`).
 */
function isTrustedForInjection(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: { userId?: string; organizationIds?: string[] }
): boolean {
  if (actor.userId && lake.createdByUserId && String(lake.createdByUserId) === actor.userId) return true;
  const lakeOrg = normalizeId(lake.organizationId);
  return !!lakeOrg && (actor.organizationIds ?? []).includes(lakeOrg);
}

/**
 * Resolves the per-lake system prompts to inject for a turn: the caller's active,
 * accessible, TRUSTED lakes that carry a non-empty `systemPrompt`.
 *
 * Applies the same accessibility rule as retrieval - the identical DB pre-filter, then
 * `lakeMatchesAccess`, the ONE shared access predicate that `getAccessibleDataLakes` itself
 * applies - and narrows the result with the trust rule above. Calling the predicate directly
 * rather than `getAccessibleDataLakes` avoids merging the static `DATA_LAKES` registry into the DB
 * candidate set - it is gathered as its OWN, separately-trusted set below instead, since a registry
 * lake has no document for `findActiveByUserTagsAndEntitlements` to return in the first place.
 * (`getDynamicDataLakeAccess` additionally drops lakes whose `datalakeTag` shadows a registry tag;
 * retrieval-specific, since it guards the tag-based file lookup and prompts never use the tag.)
 *
 * REGISTRY CANDIDATES (Phase 2): gathered from `DATA_LAKES` directly, pre-filtered to org-scoped
 * entries only - a gateless one can never pass `isTrustedForInjection`'s org arm, so fetching its
 * overlay would be pure waste. `context.db.fallbackLakeSettings` is optional and read-failure-safe
 * like every other adapter here: absent or a failed batch read means zero registry prompts, never
 * a thrown turn. A registry id already present among the DB-matched `lakes`' slugs is skipped - the
 * one (structurally rare; `disambiguateSlug` refuses to mint a NEW lake at a registry-owned slug,
 * so this only arises from a lake that predates the registry entry) case where a real document has
 * since taken over that identity and the registry entry is otherwise unreachable.
 *
 * Prompt text is read off the raw lake documents ON PURPOSE: `DataLakeConfig` is the shared
 * actor-less projection, so putting `systemPrompt` there would leak the text to every lake user
 * (it is editor-only). Keep it out of that type - the editor UI reads it from the manage-gated
 * superset `ManageableDataLakeConfig` instead, which only the actor-aware list projections build.
 *
 * Fail-safe: a lake read failure yields no prompts rather than failing the turn.
 *
 * RETRIEVAL SCOPE (#1108): pass `restrictToDatalakeTags` to keep only the lakes a turn ACTUALLY
 * used - the set of `datalake:*` tags carried by the files that were retrieved/injected this turn
 * (a lake's files carry its `datalakeTag` verbatim, see buildDatalakeTag). Applied AFTER the trust
 * filter, so a retrieved-but-untrusted lake still contributes nothing. Omit it only for a caller
 * that legitimately wants every trusted lake's prompt regardless of retrieval; injection sites must
 * always pass it, or they reintroduce the org-wide over-injection this scope exists to close.
 */
export async function getAccessibleDataLakePrompts(
  context: DataLakeAccessContext,
  options?: { restrictToDatalakeTags?: Iterable<string> }
): Promise<DataLakePrompt[]> {
  // Normalize the scope once. An EMPTY (but present) restrict set means "this turn retrieved no
  // lake" -> inject nothing; only an ABSENT set means "do not scope". Distinguished by undefined.
  const restrictTags = options?.restrictToDatalakeTags ? new Set(options.restrictToDatalakeTags) : undefined;
  if (restrictTags && restrictTags.size === 0) return [];

  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  const userId = context.user.id ? String(context.user.id) : undefined;
  // Fail closed on the projected reader rather than a bare TypeError: an unwired host gets a
  // legible error naming the missing adapter (mirrors getDynamicDataLakeAccess).
  if (typeof context.db.organizations?.findMembershipOrgIds !== 'function') {
    throw new Error(
      'getAccessibleDataLakePrompts: context.db.organizations.findMembershipOrgIds is required to resolve lake access'
    );
  }
  // Same membership resolution as getDynamicDataLakeAccess - resolved from `db.organizations`,
  // never from a selected-org pointer (#1674).
  //
  // Resolved outside the try/catch below on purpose: within THIS resolver, a transient failure
  // here propagates rather than being silently folded into "no prompts" by the fail-safe catch
  // that guards the lake read. That guarantee is local to this function - top-level chat callers
  // may still catch this throw and degrade to an empty scope, which is ALSO fail-closed (it
  // denies, never grants). The placement buys observability into where a failure originated, not
  // a stronger deny guarantee than returning [] outright would have given.
  const organizationIds = userId ? await context.db.organizations.findMembershipOrgIds(userId) : [];

  // Absent `dataLakes` (an unwired host) means the DB half yields nothing - NOT a whole-function
  // bail: a caller who never wired dataLakes but did wire fallbackLakeSettings must still reach
  // the registry branch below.
  let lakes: IDataLakeDocument[] = [];
  if (context.db.dataLakes) {
    try {
      lakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationIds,
        userId
      );
    } catch (err) {
      context.logger?.warn('[dataLakes] prompt lookup failed; injecting no lake prompts', err);
    }
  }

  // lakeMatchesAccess takes PRE-NORMALIZED inputs (its documented contract): tags lowercased,
  // entitlement keys through the canonical normalizer.
  const normalizedTags = userTags.map(tag => tag.toLowerCase());
  const normalizedKeys = entitlementKeys.map(normalizeEntitlementKey);

  const dbPrompts = lakes
    .filter(
      lake =>
        lakeMatchesAccess(lake, normalizedTags, normalizedKeys) &&
        isTrustedForInjection(lake, { userId, organizationIds }) &&
        // Retrieval scope: keep only lakes this turn actually used. `datalakeTag` is the exact
        // string a lake's files carry, so this is a precise lake<->retrieval match, not a prefix.
        (!restrictTags || restrictTags.has(lake.datalakeTag))
    )
    .map(lake => ({ id: lake.id, name: lake.name, systemPrompt: (lake.systemPrompt ?? '').trim() }));

  // Registry candidates (Phase 2) - see the function doc comment. Deliberately NOT gated behind
  // `lakes.length === 0`: a caller with zero matching DB lakes but org membership on a registry
  // lake must still reach this branch, or the injection silently never fires for that caller.
  const dynamicSlugIds = new Set(lakes.map(lake => lake.slug));
  const orgScopedRegistryCandidates: DataLakeConfig[] = DATA_LAKES.filter(
    dl =>
      !dynamicSlugIds.has(dl.id) &&
      !!normalizeId(dl.organizationId) &&
      lakeMatchesAccess(dl, normalizedTags, normalizedKeys)
  );

  let registryPrompts: DataLakePrompt[] = [];
  if (context.db.fallbackLakeSettings && orgScopedRegistryCandidates.length > 0) {
    try {
      const overlayRows = await context.db.fallbackLakeSettings.findByLakeIds(
        orgScopedRegistryCandidates.map(dl => dl.id)
      );
      const overlayByLakeId = new Map(overlayRows.map(row => [row.lakeId, row]));
      registryPrompts = orgScopedRegistryCandidates
        .filter(
          dl =>
            isTrustedForInjection(
              { createdByUserId: '', organizationId: dl.organizationId },
              { userId, organizationIds }
            ) &&
            (!restrictTags || restrictTags.has(dl.datalakeTag))
        )
        .map(dl => ({
          id: dl.id,
          name: dl.name,
          systemPrompt: (overlayByLakeId.get(dl.id)?.systemPrompt ?? '').trim(),
        }));
    } catch (err) {
      context.logger?.warn('[dataLakes] registry prompt overlay lookup failed; injecting no registry prompts', err);
    }
  }

  return (
    [...dbPrompts, ...registryPrompts]
      .filter(lake => lake.systemPrompt.length > 0)
      // Stable order keeps the rendered prompt byte-identical across turns, so it stays
      // prompt-cache friendly (lake documents come back in no guaranteed order). Tie-break on id:
      // names are not unique, and localeCompare alone would leave same-named lakes free to swap.
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  );
}
