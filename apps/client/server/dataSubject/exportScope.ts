import type { DataHolder, UserReference } from './types';

/**
 * What a person's export takes from one document (the rules are stated in `types.ts`).
 * - `wholeDocument`: every field minus `secretPaths`, plus the document's `viaParent` children.
 * - `matchedPaths`: only these paths and the document id. A path through an array (`versions.createdBy`)
 *   means the matching elements of that array, not the whole array.
 */
export type ExportScope =
  { scope: 'none' } | { scope: 'wholeDocument' } | { scope: 'matchedPaths'; paths: readonly string[] };

/** A reference whose filter matched the person on this document. */
export type ReferenceMatch = {
  reference: UserReference;
  /** Whether `reference.path` runs through an array (`userIds`, `users.userId`), from the schema. */
  throughArray: boolean;
};

const NO_EXPORT: ExportScope = { scope: 'none' };

/**
 * A `deleteDocument` or `retain` match on a scalar path marks the document as the person's own
 * record, so it is exported whole. Every other match (an `anonymize`, a `pullFromArray`, or any
 * match through an array) records the person inside a document that is someone else's, so only the
 * matched paths are exported.
 */
export function holderExportScope(matches: readonly ReferenceMatch[]): ExportScope {
  if (matches.length === 0) return NO_EXPORT;
  if (matches.some(isOwnRecordMatch)) return { scope: 'wholeDocument' };
  return { scope: 'matchedPaths', paths: uniquePaths(matches) };
}

/**
 * A `viaParent` child follows its parent only when the parent is the person's own record (exported
 * whole), or when it is the person's own content under a parent that merely records them
 * (`deleteWhenParentAnonymized`). Otherwise it is exported only when the person matches one of its
 * own `attribution` references, and then only those paths.
 */
export function viaParentExportScope(
  child: Extract<DataHolder, { kind: 'viaParent' }>,
  parentScope: ExportScope,
  attributionMatches: readonly ReferenceMatch[]
): ExportScope {
  if (parentScope.scope === 'wholeDocument') return { scope: 'wholeDocument' };
  if (parentScope.scope === 'matchedPaths' && child.deleteWhenParentAnonymized) return { scope: 'wholeDocument' };
  return holderExportScope(attributionMatches);
}

function isOwnRecordMatch({ reference, throughArray }: ReferenceMatch): boolean {
  return !throughArray && (reference.action === 'deleteDocument' || reference.action === 'retain');
}

// An `anonymize` reference's `alsoRedact` fields repeat the matched person's identity (a cached name,
// email or IP of the same person), so they are that person's data and travel with the match.
function uniquePaths(matches: readonly ReferenceMatch[]): string[] {
  const paths = matches.flatMap(({ reference }) =>
    reference.action === 'anonymize' ? [reference.path, ...(reference.alsoRedact ?? [])] : [reference.path]
  );
  return [...new Set(paths)];
}
