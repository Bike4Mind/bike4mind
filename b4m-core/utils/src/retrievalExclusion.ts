import { escapeRegex } from './escapeRegex';

/**
 * Generic retrieval-exclusion options: which lake documents must be kept OUT of
 * tutor/RAG retrieval so retrieval agrees with the document-listing predicate.
 *
 * This is the HOST-side, product-neutral primitive. A product surface opts in by
 * stamping the matching session fields (retrievalExcludeFilenameMarkers /
 * retrievalVectorizedOnly). Host core carries no product-specific marker literals.
 *
 * `excludeFilenameMarkers` are matched as a case-insensitive LEADING marker at a
 * WORD BOUNDARY, NOT a bare prefix - so a marker of `mark` excludes `MARK - foo.pdf`
 * but leaves a legitimate `MARKdown.pdf` untouched. This must stay in sync with any
 * consumer's own listing predicate (e.g. an overlay's isListableLakeDoc).
 */
export interface RetrievalExclusionOptions {
  /** Leading filename markers to exclude (case-insensitive, word-boundary anchored). */
  excludeFilenameMarkers?: string[];
  /** When true, only vectorized files are retrievable (unvectorized files are excluded). */
  vectorizedOnly?: boolean;
}

/** Max characters per exclusion marker - shared by every schema that validates the session field. */
export const RETRIEVAL_EXCLUDE_MARKER_MAX_LENGTH = 128;
/** Max number of exclusion markers per session - shared by every schema that validates the field. */
export const RETRIEVAL_EXCLUDE_MARKERS_MAX = 20;

/**
 * Map the raw session fields (`retrievalExcludeFilenameMarkers` / `retrievalVectorizedOnly`)
 * to a `RetrievalExclusionOptions`. Single mapping shared by every tool-build path
 * (chat completion, agent execution, delegated subagents) so the session -> filter
 * translation can't drift between them. Accepts a structural shape to avoid importing
 * the `ISession` type into `@bike4mind/utils`.
 */
export function toRetrievalFilter(source: {
  retrievalExcludeFilenameMarkers?: string[] | null;
  retrievalVectorizedOnly?: boolean | null;
}): RetrievalExclusionOptions {
  return {
    excludeFilenameMarkers: source.retrievalExcludeFilenameMarkers ?? undefined,
    vectorizedOnly: source.retrievalVectorizedOnly ?? undefined,
  };
}

/** Trim, lowercase, and drop empty/whitespace markers. Empty result == no filtering. */
export function normalizeExclusionMarkers(markers?: string[]): string[] {
  return (markers ?? []).map(m => m.trim().toLowerCase()).filter(Boolean);
}

/**
 * Build the anchored leading-marker alternation, or `null` when no usable markers remain.
 *
 * The trailing boundary is written as `($|[^a-z0-9_])` rather than the PCRE `\b` word-boundary
 * escape ON PURPOSE: this regex is used verbatim in a DocumentDB `$regex`/`$not` query (see
 * fabFileSearchQuery), and DocumentDB's regex engine supports only a subset of PCRE - anchors,
 * alternation, and character classes are safe, `\b` is not attested and there is no `\b`
 * precedent anywhere in this codebase's DB queries. For a leading marker the two are equivalent
 * for word-token markers (the realistic case): the marker must be at the start and be followed
 * by end-of-string or a non-word char, so `MARK - foo.pdf` matches while `MARKdown.pdf` does not.
 *
 * Deliberately carries NO `i` flag: callers match it against the pre-lowered `fileNameLower`
 * field (index-safe) and lowercase markers here, so the alternation is already lowercase.
 * Returning `null` for the empty case is what guarantees an unset/empty marker list is a
 * byte-identical no-op rather than an `^`-matches-everything blackout.
 */
export function buildFilenameMarkerRegex(markers?: string[]): RegExp | null {
  const norm = normalizeExclusionMarkers(markers);
  if (norm.length === 0) return null;
  return new RegExp(`^(${norm.map(escapeRegex).join('|')})($|[^a-z0-9_])`);
}

/**
 * In-memory retrieval-exclusion predicate: `true` when this file must be excluded.
 *
 * Single source of truth shared with the query-builder clauses (buildFabFileSearchQuery)
 * so an in-memory guard can never diverge from what the query would have filtered. Because
 * it reads the raw `fileName` (always present) rather than the DB `fileNameLower` field, it is
 * both fail-closed (a missing lowercase field can't open a hole) and DocumentDB-engine-
 * independent - which is why the search arms apply it as an authoritative post-filter on top
 * of the best-effort DB pre-filter. Fail-closed by design.
 */
export function isRetrievalExcluded(
  file: { fileName?: string | null; vectorized?: boolean },
  opts: RetrievalExclusionOptions
): boolean {
  if (opts.vectorizedOnly && !file.vectorized) return true;
  const re = buildFilenameMarkerRegex(opts.excludeFilenameMarkers);
  return !!re && re.test((file.fileName ?? '').toLowerCase());
}

/**
 * Authoritative in-memory post-filter: drop every file the exclusion options exclude.
 * A byte-identical passthrough when `opts` is empty. Applied by the search arms to the
 * candidate set so retrieval correctness never depends on the DB regex engine or on the
 * `fileNameLower` field being populated (see isRetrievalExcluded).
 */
export function filterRetrievalExcluded<T extends { fileName?: string | null; vectorized?: boolean }>(
  files: T[],
  opts: RetrievalExclusionOptions
): T[] {
  if (!opts.vectorizedOnly && normalizeExclusionMarkers(opts.excludeFilenameMarkers).length === 0) {
    return files;
  }
  return files.filter(f => !isRetrievalExcluded(f, opts));
}
