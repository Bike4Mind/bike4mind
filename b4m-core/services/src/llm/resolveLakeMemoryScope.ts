/**
 * Which lakes the lake-memory hot card may read on a turn.
 *
 * There are THREE session states here, not two: lakes named, every lake deselected, and no lake
 * scope expressed at all. Only the last falls back to the full entitled set - the pre-existing
 * behavior for sessions whose scope nothing ever set. `lakeScopeExplicit` is what separates the
 * middle state from the last: Mongoose hydrates an omitted array to `[]`, so an empty
 * `retrievalTags` cannot carry "the user deselected everything" on its own.
 *
 * Deliberately NOT shared with KnowledgeRetrievalFeature, which keeps the widening fallback:
 * searching every entitled lake when the user asked for a search is not the same as injecting
 * every entitled lake's beliefs unasked.
 */
export const resolveLakeMemoryScope = (input: {
  /** Lakes this user may read (getDynamicDataLakeAccess). */
  entitledTags: string[];
  /** `session.retrievalTags`. Not universally lake identity; a non-lake tag matches nothing. */
  retrievalTags: string[] | undefined;
  /** `session.lakeScopeExplicit` - the scope beside it is a deliberate selection, empty or not. */
  lakeScopeExplicit: boolean | undefined;
}): string[] => {
  const { entitledTags, retrievalTags, lakeScopeExplicit } = input;
  if (retrievalTags?.length) return entitledTags.filter(tag => retrievalTags.includes(tag));
  return lakeScopeExplicit ? [] : entitledTags;
};
