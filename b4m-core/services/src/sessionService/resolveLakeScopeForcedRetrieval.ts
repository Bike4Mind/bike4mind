export interface LakeScopeForcedRetrievalInput {
  /** The caller's own `forceKnowledgeRetrieval`. `undefined` means unsent; `false` is an opt-out. */
  forceKnowledgeRetrieval: boolean | undefined;
  /** The session's resolved lake scope. */
  retrievalTags: string[] | undefined;
  /** `lakeScopeExplicit` - the scope beside it is a deliberate selection, empty or not. */
  lakeScopeExplicit: boolean | undefined;
}

/**
 * Whether a session born scoped to a lake should also be born with forced retrieval on.
 *
 * A caller that declared a lake scope has already said where its answers come from, but with the
 * flag left unset the search was left to the model's own discretion - it fired on roughly a quarter
 * of turns across a 200-question bank, and the turns that skipped it scored materially worse.
 * Sessions created through `dataLakeId` never had this problem because resolveLakeSessionDefaults
 * sets the flag for them; this covers the other binding, `retrievalTags` + `lakeScopeExplicit`,
 * which no lake-defaults merge ever reaches.
 *
 * Explicit-wins, so `forceKnowledgeRetrieval: false` remains a per-session opt-out. Returns
 * `undefined` rather than `false` when nothing applies, so the field stays absent on a session that
 * never named a lake instead of being written as an explicit off.
 *
 * Requires a NON-EMPTY scope: `lakeScopeExplicit` with no tags is a deliberate "no lake", where
 * forcing retrieval would force it against nothing. Requires the marker too, and not merely tags -
 * an unmarked `retrievalTags` can be one deriveRetrievalTagsFromFiles inferred from an attached
 * file, which is not the caller declaring anything.
 */
export function resolveLakeScopeForcedRetrieval(input: LakeScopeForcedRetrievalInput): boolean | undefined {
  const { forceKnowledgeRetrieval, retrievalTags, lakeScopeExplicit } = input;
  if (forceKnowledgeRetrieval !== undefined) return forceKnowledgeRetrieval;
  return lakeScopeExplicit && retrievalTags?.length ? true : undefined;
}
