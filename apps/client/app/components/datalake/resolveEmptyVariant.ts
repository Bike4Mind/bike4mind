/**
 * Which "nothing to browse" situation the surface is in. Passed explicitly rather than inferred
 * from which callbacks happen to be set: the create-first CTA used to key off `onCreate`'s
 * presence, which the caller derived from an EMPTY-SCOPE test, so a user with lakes was told to
 * create their first one (#1645). The distinction the caller cannot fudge is now in the type.
 *
 * `lakes-error` is separate from `no-lakes` on purpose - a failed read must never render as a
 * confident zero.
 */
export type DataLakeEmptyVariant = 'no-selection' | 'no-lakes' | 'lakes-error' | 'lake-empty' | 'all-lakes-empty';

export interface EmptyVariantInputs {
  /** The lake-list read failed. Takes precedence over every other signal. */
  lakesError: boolean;
  /** The lake-list read is still in flight, so the lake count is not yet known. */
  lakesLoading: boolean;
  /** Number of lakes the caller can reach. Only meaningful once the read succeeded. */
  lakeCount: number;
  /**
   * Of those, how many the caller can actually MANAGE. Load-bearing for the first-run prompt: the
   * list includes built-in fallback lakes (and strangers' public ones), which every user can reach
   * and nobody owns, so `lakeCount` alone is effectively never 0 and keying the prompt on it would
   * retire first-run guidance entirely. "No lakes of your own" is the question being asked.
   */
  manageableLakeCount: number;
  /** Whether a specific lake is currently scoped. */
  hasSelectedLake: boolean;
  /** Nothing to browse in the CURRENT scope - says nothing about how many lakes exist. */
  isScopeEmpty: boolean;
}

/**
 * Picks the "nothing to browse" state for the in-chat tree (DataLakeTreeEmptyState).
 *
 * The precedence is the correctness of this function, not a detail of it. The bug it replaces
 * (#1645) inferred a ZERO-LAKE state from an EMPTY-SCOPE test, so a user who already had lakes was
 * shown "Create your first data lake" whenever the current view happened to hold no files.
 *
 * Two orderings are load-bearing:
 *  - `lakesError` outranks everything. A failed read must never degrade into `no-lakes`: that would
 *    borrow the zero-state's meaning from an unknown, and invite a user with lakes to create a
 *    duplicate. "Could not read" and "there are none" are different facts.
 *  - `lakesLoading` outranks `no-lakes` for the same reason - an in-flight read has no count yet, so
 *    a confident zero would flash the first-run prompt on every load.
 *
 * Both therefore fall back to `no-selection`, the neutral state that asserts nothing about how many
 * lakes exist and leaves the tree its own plain empty line.
 *
 * The empty-scope split is the same principle one level down: `no-selection` asserts nothing, so it
 * may stand in wherever a specific reason is not yet knowable. With lakes present but no files
 * anywhere, the all-lakes view has an empty tree, and pointing at a lake would be the same kind of
 * lie.
 */
export function resolveEmptyVariant({
  lakesError,
  lakesLoading,
  lakeCount,
  manageableLakeCount,
  hasSelectedLake,
  isScopeEmpty,
}: EmptyVariantInputs): DataLakeEmptyVariant {
  if (lakesError) return 'lakes-error';
  if (lakesLoading) return 'no-selection';
  if (lakeCount === 0) return 'no-lakes';
  if (isScopeEmpty) {
    if (hasSelectedLake) return 'lake-empty';
    // Nothing to browse AND nothing of the caller's own: a genuine first run, even though a
    // read-only built-in lake is listed. Gated on isScopeEmpty so this can never appear beside a
    // populated tree - "create your first lake" over someone else's browsable content is its own lie.
    if (manageableLakeCount === 0) return 'no-lakes';
    return 'all-lakes-empty';
  }
  return 'no-selection';
}
