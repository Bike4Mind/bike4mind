import type { DataLakeGroundingMode, IDataLake } from '@bike4mind/common';
import { DEFAULT_DATA_LAKE_GROUNDING_MODE } from '@bike4mind/common';

/**
 * The session fields a data lake contributes when a session is created FOR that lake.
 *
 * MULTI-FIELD BY DESIGN. This is the one seam that maps a lake to its session defaults, and it is
 * meant to grow: the per-lake grounding mode (inline vs retrieve) resolves here too, onto the same
 * mechanism, rather than as a second disjoint per-lake config path. Keep it a plain
 * lake -> partial-session-params mapping so new per-lake fields slot in without reshaping callers.
 *
 * Only the fields a lake actually sets are returned; the caller merges them UNDER any explicit
 * request values (explicit-wins), so an id the user set by hand always beats the lake default.
 */
export interface LakeSessionDefaults {
  /** A session created for a lake grounds against it, so forced retrieval is on. */
  forceKnowledgeRetrieval?: boolean;
  /**
   * Scopes forced retrieval to THIS lake (its `datalakeTag`). This is also what makes the router's
   * step-1 SEARCH real rather than "retrieval-flavoured prose with nothing behind it": the session
   * can demonstrably reach the lake it was created for.
   */
  retrievalTags?: string[];
  /**
   * The lake's preferred registry prompt id, resolved once here (create-time). Set only when the
   * lake declares one; still re-checked against the session-activatable allowlist by the completion
   * path's resolver, so a stale or non-activatable id injects nothing rather than an arbitrary prompt.
   */
  systemPromptId?: string;
  /**
   * How this lake's corpus is grounded (inline vs retrieve vs auto-by-size). ALWAYS set for a lake
   * session - to the lake's stored mode or the default ('retrieve') - so an owner and an
   * entitlement-only reader of the same lake ground identically instead of the behavior falling
   * out of a per-file CASL read. The completion path's corpus defer plan reads
   * `session.corpusGroundingMode` and honors this explicit mode; a session NOT created for a lake
   * leaves it unset, which the plan treats as its pre-existing size-only behavior.
   */
  corpusGroundingMode?: DataLakeGroundingMode;
}

/**
 * Pure mapping from a lake to the session defaults it contributes. No I/O and no access check -
 * the CALLER must have already resolved and access-gated the lake (e.g. via assertLakeAccess), so
 * we never arm a lake's prompt for a caller who cannot reach it. Pure so it is trivially testable
 * across every field-combination shape.
 */
export function resolveLakeSessionDefaults(
  lake: Pick<IDataLake, 'datalakeTag' | 'preferredSystemPromptId' | 'groundingMode'>
): LakeSessionDefaults {
  const defaults: LakeSessionDefaults = { forceKnowledgeRetrieval: true };
  // Scope to this lake only when it carries a join tag. Real lakes always do; a static-registry
  // fallback might not, and `retrievalTags: [undefined]` would scope retrieval to nothing.
  if (lake.datalakeTag) {
    defaults.retrievalTags = [lake.datalakeTag];
  }
  // Empty/absent means "no preferred prompt" - leave systemPromptId unset so the session keeps its
  // generic prompt rather than binding to a blank id.
  if (lake.preferredSystemPromptId) {
    defaults.systemPromptId = lake.preferredSystemPromptId;
  }
  // Grounding mode is ALWAYS set for a lake session (unlike the two fields above, which are opt-in):
  // an absent stored value coalesces to the default so a lake predating the field grounds like a new
  // one, and so a lake session is never left in the plan's "no explicit mode" branch (that branch is
  // for NON-lake sessions, which must keep the pre-existing size-only behavior).
  defaults.corpusGroundingMode = lake.groundingMode ?? DEFAULT_DATA_LAKE_GROUNDING_MODE;
  return defaults;
}
