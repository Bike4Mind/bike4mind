import { sessionGroundsOnNoLake } from '../dataLakeService/narrowLakeAccessToSession';

/**
 * Which lakes the lake-memory hot card may read on a turn.
 *
 * There are THREE session states here, not two: lakes named, every lake deselected, and no lake
 * scope expressed at all. Only the last falls back to the full entitled set - the pre-existing
 * behavior for sessions whose scope nothing ever set. `lakeScopeExplicit` is what separates the
 * middle state from the last: Mongoose hydrates an omitted array to `[]`, so an empty
 * `retrievalTags` cannot carry "the user deselected everything" on its own.
 *
 * The middle state is `sessionGroundsOnNoLake`, and it must stay shared with every other
 * lake-scope consumer: this surface honouring it alone is what let a chat report "no data lakes"
 * while forced retrieval ground on all of them. What stays LOCAL to this surface is the last
 * state's widening fallback - with no scope expressed, searching every entitled lake when the
 * user asked for a search is not the same as injecting every entitled lake's beliefs unasked.
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
  if (sessionGroundsOnNoLake(retrievalTags, lakeScopeExplicit)) return [];
  if (retrievalTags?.length) return entitledTags.filter(tag => retrievalTags.includes(tag));
  return entitledTags;
};
