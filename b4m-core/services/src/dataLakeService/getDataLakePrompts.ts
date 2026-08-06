import { DATALAKE_TAG_PREFIX, lakeMatchesAccess, normalizeEntitlementKey } from '@bike4mind/common';
import type { IDataLakeDocument } from '@bike4mind/common';
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
 * Trusted = the caller's own lake, or a lake scoped to the caller's org (the org admin
 * governance path). The surviving lakes are rendered by renderDataLakePromptSection at each
 * retrieval-scoped injection site (forced retrieval + the model-driven knowledge tools).
 *
 * Both sides of the org comparison are normalized through normalizeId (which yields undefined for
 * an absent value, so it never becomes the string "undefined"). The schema stores these as Strings
 * today, but an ObjectId- or populated-document-vs-String comparison would fail SILENTLY - denying
 * injection with no error - which is the hard failure mode to notice. Same reasoning and normalizer
 * as the actor-side coercion in the resolver (#1281 / @bike4mind/utils/normalizeId).
 */
function isTrustedForInjection(
  lake: Pick<IDataLakeDocument, 'createdByUserId' | 'organizationId'>,
  actor: { userId?: string; organizationId?: string }
): boolean {
  if (actor.userId && lake.createdByUserId && String(lake.createdByUserId) === actor.userId) return true;
  const lakeOrg = normalizeId(lake.organizationId);
  const actorOrg = normalizeId(actor.organizationId);
  return !!lakeOrg && !!actorOrg && lakeOrg === actorOrg;
}

/**
 * Resolves the per-lake system prompts to inject for a turn: the caller's active,
 * accessible, TRUSTED lakes that carry a non-empty `systemPrompt`.
 *
 * Applies the same accessibility rule as retrieval - the identical DB pre-filter, then
 * `lakeMatchesAccess`, the ONE shared access predicate that `getAccessibleDataLakes` itself
 * applies - and narrows the result with the trust rule above. Calling the predicate directly
 * rather than `getAccessibleDataLakes` avoids merging the static `DATA_LAKES` registry into a
 * result this resolver only filters back out. (`getDynamicDataLakeAccess` additionally drops lakes
 * whose `datalakeTag` shadows a registry tag; retrieval-specific, since it guards the tag-based
 * file lookup and prompts never use the tag.)
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
  const repo = context.db.dataLakes;
  if (!repo) return [];

  // Normalize the scope once. An EMPTY (but present) restrict set means "this turn retrieved no
  // lake" -> inject nothing; only an ABSENT set means "do not scope". Distinguished by undefined.
  const restrictTags = options?.restrictToDatalakeTags ? new Set(options.restrictToDatalakeTags) : undefined;
  if (restrictTags && restrictTags.size === 0) return [];

  const userTags = context.user.tags || [];
  const entitlementKeys = context.entitlementKeys ?? [];
  // Normalize for the same reason getDynamicDataLakeAccess does: a hydrated user doc carries an
  // ObjectId (or a populated Organization document), and the lake's owner/org fields are Strings.
  const organizationId = normalizeId(context.user.organizationId);
  const userId = context.user.id ? String(context.user.id) : undefined;

  let lakes: IDataLakeDocument[];
  try {
    lakes = await repo.findActiveByUserTagsAndEntitlements(userTags, entitlementKeys, organizationId, userId);
  } catch (err) {
    context.logger?.warn('[dataLakes] prompt lookup failed; injecting no lake prompts', err);
    return [];
  }
  if (lakes.length === 0) return [];

  // lakeMatchesAccess takes PRE-NORMALIZED inputs (its documented contract): tags lowercased,
  // entitlement keys through the canonical normalizer.
  const normalizedTags = userTags.map(tag => tag.toLowerCase());
  const normalizedKeys = entitlementKeys.map(normalizeEntitlementKey);

  return (
    lakes
      .filter(
        lake =>
          lakeMatchesAccess(lake, normalizedTags, normalizedKeys) &&
          isTrustedForInjection(lake, { userId, organizationId }) &&
          // Retrieval scope: keep only lakes this turn actually used. `datalakeTag` is the exact
          // string a lake's files carry, so this is a precise lake<->retrieval match, not a prefix.
          (!restrictTags || restrictTags.has(lake.datalakeTag))
      )
      .map(lake => ({ id: lake.id, name: lake.name, systemPrompt: (lake.systemPrompt ?? '').trim() }))
      .filter(lake => lake.systemPrompt.length > 0)
      // Stable order keeps the rendered prompt byte-identical across turns, so it stays
      // prompt-cache friendly (lake documents come back in no guaranteed order). Tie-break on id:
      // names are not unique, and localeCompare alone would leave same-named lakes free to swap.
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  );
}
