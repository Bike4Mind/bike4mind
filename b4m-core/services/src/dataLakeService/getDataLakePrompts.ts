import { DATA_LAKES, DATALAKE_TAG_PREFIX, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import type { DataLakeConfig, IDataLakeDocument } from '@bike4mind/common';
import { normalizeId } from '@bike4mind/utils/normalizeId';
import type { DataLakeAccessContext } from './getDynamicDataLakeTags';
import { filterStillManagedLakes, type ManageRecheckAdapter } from './filterStillManagedLakes';
import { grantedLakeReachFor } from './resolveLakeReadAccess';
import { isDatalakeTagWellFormed } from './createDataLake';

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
 * A THIRD trust arm lives OUTSIDE this predicate, in getAccessibleDataLakePrompts' in-memory
 * filter: an owner/curator GRANT on the lake. It cannot live here, because a grant has to bypass
 * `lakeMatchesAccess` as well - that predicate is grant-blind, so a lake whose only claim is a
 * grant row would be dropped as inaccessible before trust was ever consulted. See the grant-arm
 * comments there; do NOT add it to this function without also relaxing that conjunct, or the arm
 * is dead code.
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
 * NOTE (#1668): the owner arm keys on `createdByUserId`, which never moves - so a TRANSFERRED lake
 * is not trusted for its new owner by this predicate. That case, and the shared-across-orgs curator
 * case with it, is now covered by the grant arm above rather than left to the org arm.
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
 * Applies the same accessibility rule as retrieval - the identical DB pre-filter (including its
 * owner/curator grant arm), then `lakeMatchesAccess`, the ONE shared access predicate that
 * `getAccessibleDataLakes` itself applies - and narrows the result with the trust rule above,
 * whose grant arm is applied here (see the GRANT ARM block below). Calling the predicate directly
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
 *
 * PRE-AUTHORIZED LAKES (manager-but-not-member admission): `options.preauthorizedLakeIds` names DB lake ids a
 * manager was admitted to at session-create time (canManageLake - see pages/api/sessions/create.ts) and
 * RE-DERIVED here per turn via filterStillManagedLakes, so revoking someone's manage rights revokes the
 * sessions they already created; the session's list is a record of what was admitted, never the authority for
 * it. Such a lake is unioned into the DB candidate query below (it would otherwise never match
 * `findActiveByUserTagsAndEntitlements`'s tag/entitlement/org predicate at all) and short-circuits
 * `isTrustedForInjection` in the in-memory filter - but `restrictTags` stays an UNCONDITIONAL separate
 * conjunct, so a pre-authorized lake still only contributes when the turn actually retrieved it. Deliberately
 * DB-lake-only: the registry/fallback-lake candidate gathering and its own trust check below are
 * retrieval-only and must never be pierced here - a fallback lake's prompt keeps requiring its ordinary
 * org-trust arm regardless of pre-authorization.
 *
 * GRANT ARM (#2495): a lake the caller holds an owner or curator grant on is BOTH accessible and
 * injection-trusted by that grant alone - so its ids enter the DB query as its grant arm and then
 * short-circuit `lakeMatchesAccess` + `isTrustedForInjection` in the in-memory filter, exactly as a
 * pre-authorized id does. This is the arm the trust rule's own doc comment used to defer.
 *
 * ITS AUDIENCE IS NOW WIDER THAN WHEN THIS ARM LANDED, and a reader has to know it. The arm was
 * written when the only producers of owner/curator grants were createDataLake (a self-grant) and
 * transferLakeOwnership, whose out-of-org refusal meant both parties to a transfer were already
 * org-trusted - so the only case it changed was the TRANSFERRED PERSONAL lake, where
 * `createdByUserId` never moves and the new owner held the lake's prompt inert. `grantLakeAccess`
 * is the sharing door that was missing then: a manager can now hand a CURATOR grant to an arbitrary
 * cross-tenant user, and that grant carries injection trust through this arm the moment it lands.
 * That is the intended delivery, not a leak - but it means a curator grant is a decision about whose
 * turn this lake's prompt may steer, and the grant UI discloses it as one.
 *
 * Why curator-or-above is the right cap, and not merely a cautious one: `listDataLakes` serves
 * `systemPrompt` back only when `manageable` holds, so this arm's audience is exactly the audience
 * that can READ the text steering their own turn. A reader/tag/entitlement holder could not, which
 * is the transparency argument the trust rule's doc comment makes at the top of this file.
 * `restrictTags` remains an unconditional separate conjunct, so a granted lake still contributes
 * only on a turn that actually retrieved from it.
 */
export async function getAccessibleDataLakePrompts(
  // The re-check slice is intersected here rather than added to DataLakeAccessContext because only
  // this function runs the manage re-check; getDynamicDataLakeAccess shares the context and has no
  // pre-authorization concept.
  context: DataLakeAccessContext & { db: ManageRecheckAdapter },
  options?: { restrictToDatalakeTags?: Iterable<string>; preauthorizedLakeIds?: Iterable<string> }
): Promise<DataLakePrompt[]> {
  // Normalize the scope once. An EMPTY (but present) restrict set means "this turn retrieved no
  // lake" -> inject nothing; only an ABSENT set means "do not scope". Distinguished by undefined.
  const restrictTags = options?.restrictToDatalakeTags ? new Set(options.restrictToDatalakeTags) : undefined;
  if (restrictTags && restrictTags.size === 0) return [];
  const preauthorizedIds = options?.preauthorizedLakeIds ? new Set(options.preauthorizedLakeIds) : undefined;

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

  // The lake ids the caller reaches by an owner/curator grant (see GRANT ARM in the doc comment).
  // Resolved BEFORE the lake read for the same reason as in getDynamicDataLakeAccess: a grant-held
  // lake matches none of that query's tag/org/public arms, so its ids have to go IN as the query's
  // grant arm rather than be filtered out of the result.
  //
  // Uses the same helper as the retrieval resolver, so the two sides resolve a grant row the same
  // way - a lake retrieval grounds on but injection distrusts is exactly the gap #2495 closes.
  // Sharing the helper is not by itself a lockstep guarantee: the two call sites already pass
  // different arguments, and today's agreement rests on both pinning `includeReaders = false`.
  // That agreement is MEANT to be broken by the cutover, in the deny direction only - see below.
  //
  // But `includeReaders: false` here is a PERMANENT security floor, NOT the cutover default it is
  // at the other call sites. That cutover has HAPPENED: `getDynamicDataLakeAccess` and browse have
  // widened to reader/org-principal grants, and THIS SITE MUST NOT FOLLOW - a READER's read
  // access must not become authority to write instructions into another user's system prompt
  // (injection lands in the system prompt, a higher-trust position than the retrieved content
  // `renderRetrievedContentBlock` sanitizes precisely because it is untrusted). A test asserts this
  // call's arguments literally, so the flip fails loudly here rather than widening quietly.
  //
  // The membership org ids are deliberately NOT passed: `grantedLakeReachFor` reads them only under
  // `includeReaders`, so threading them would leave the org-principal arm pre-wired and let a
  // one-word flip activate it silently. Passing [] makes that flip return nothing and break
  // visibly. (Org-principal grants are not absent from injection altogether - they can still reach
  // it through the pre-authorization short-circuit below, gated on org-ADMIN rights at session
  // create - but they do not enter through THIS arm.)
  //
  // Gated on `dataLakes` too: the arm feeds only the DB query and the DB-lake filter (a registry
  // lake has no grants by construction), so without a lake repo this read has no reader.
  const INCLUDE_READER_GRANTS = false;
  const grantedLakeIds = new Set<string>();
  if (context.db.dataLakes && context.db.dataLakeAccessGrants && userId) {
    try {
      // Only the USER-principal reach is consumed. `orgGrantedLakes` is empty by construction
      // here (no membership org ids, `includeReaders` false) and is deliberately not forwarded to
      // the query, so the org-principal arm cannot activate on this path even if that changes.
      const reach = await grantedLakeReachFor(userId, [], context.db.dataLakeAccessGrants, INCLUDE_READER_GRANTS);
      for (const id of reach.grantedLakeIds) grantedLakeIds.add(id);
    } catch (err) {
      // Fail closed, loudly: the arm contributes nothing, which denies a legitimate curator their
      // lake's prompt rather than granting anyone one. Warned rather than thrown so a transient
      // grant-read failure degrades this one feature instead of the turn (see Fail-safe above).
      context.logger?.warn(
        '[dataLakes] prompt access-grant lookup failed; resolving lake prompts without the grant arm',
        err
      );
    }
  }

  // Absent `dataLakes` (an unwired host) means the DB half yields nothing - NOT a whole-function
  // bail: a caller who never wired dataLakes but did wire fallbackLakeSettings must still reach
  // the registry branch below.
  let lakes: IDataLakeDocument[] = [];
  // The pre-authorized ids that STILL pass the manage gate this turn (see the union block below).
  // `undefined` means the re-check never ran - no pre-authorized ids, or no reader to run it with -
  // which is indistinguishable from "none survived" for every consumer, both denying.
  let stillManagedPreauthorizedIds: Set<string> | undefined;
  if (context.db.dataLakes) {
    try {
      lakes = await context.db.dataLakes.findActiveByUserTagsAndEntitlements(
        userTags,
        entitlementKeys,
        organizationIds,
        userId,
        { grantedLakeIds: [...grantedLakeIds] }
      );
      // Union in any pre-authorized lake not already returned above - a manage-but-not-member
      // lake fails the ordinary tag/entitlement/org predicate by construction, so it would
      // otherwise never reach the in-memory filter for its short-circuit to matter.
      if (preauthorizedIds && preauthorizedIds.size > 0 && context.db.dataLakes.findById) {
        const findById = context.db.dataLakes.findById.bind(context.db.dataLakes);
        const existingIds = new Set(lakes.map(lake => lake.id));
        const missingIds = [...preauthorizedIds].filter(id => !existingIds.has(id));
        const fetched = await Promise.all(missingIds.map(id => findById(id)));
        // Re-derive the manage gate the admission was granted under. Covers the ids the ordinary
        // predicate ALREADY returned as well as the missing ones, because the re-check governs the
        // trust short-circuit too: an id checked only when it was missing would keep piercing
        // isTrustedForInjection for a revoked maintainer who happens to also be a member.
        const candidates = [
          ...lakes.filter(lake => preauthorizedIds.has(lake.id)),
          ...fetched.filter((lake): lake is IDataLakeDocument => !!lake && lake.status === 'active'),
        ];
        const stillManaged = await filterStillManagedLakes(candidates, userId ?? '', context.db);
        stillManagedPreauthorizedIds = new Set(stillManaged.map(lake => lake.id));
        // A revoked id is not merely denied its short-circuit - it must not become a candidate at
        // all, or its slug would suppress the matching registry lake in `dynamicSlugIds` below.
        for (const lake of stillManaged) {
          if (!existingIds.has(lake.id)) lakes.push(lake);
        }
      }
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
        // Two short-circuits of the ordinary access+trust check, both standing on a MANAGE-level
        // relationship to the lake rather than on read access to its files:
        //   - a pre-authorized lake, trusted BY the admission itself - re-derived above against the
        //     current manage rights, not taken on the session's word (see the doc comment);
        //   - an owner/curator GRANT, which is simultaneously the read authorization (as at the
        //     browse gate) and the injection trust, so it has to bypass the grant-blind
        //     `lakeMatchesAccess` as well as `isTrustedForInjection` (see GRANT ARM).
        // `restrictTags` stays OUTSIDE this OR as an unconditional separate conjunct below, so
        // neither short-circuit ever injects a prompt the turn did not actually retrieve.
        (!!stillManagedPreauthorizedIds?.has(lake.id) ||
          // Well-formedness mirrors the SAME screen retrieval puts on its grant restoration
          // (getDynamicDataLakeAccess's grantedGatedLakes). Without it a granted row whose
          // datalakeTag shadows a registry lake's could inject on a turn that retrieved the
          // REGISTRY lake's files - retrieval drops such a row, and injection must not be a
          // superset of retrieval. Needs a legacy shadowing row to reach, so this is
          // defense-in-depth, not a live repro.
          (grantedLakeIds.has(lake.id) && isDatalakeTagWellFormed(lake)) ||
          (lakeMatchesAccess(lake, normalizedTags, normalizedKeys) &&
            isTrustedForInjection(lake, { userId, organizationIds }))) &&
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
          // No grant arm here, and not by omission: a registry lake has no backing document and
          // therefore no grant rows (see loadActiveLakeGrants' fallback short-circuit), so the org
          // arm below is the whole of registry-lake injection trust - the scope decided above.
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
