/**
 * SOURCE identity for a lake member: which document a file is a generation OF, as opposed to what
 * its text currently says.
 *
 * Extracted from `partitionBySupersession` (dataLakeService/supersession.ts), which derived this key
 * privately for the retrieval-time collapse. Two other readers now need the identical derivation -
 * the membership report's duplicate grouping and the admission checkpoint's same-identity detection -
 * and three private copies of a tiered key is how they drift. Nothing here does I/O and nothing here
 * imports a sibling module, so it is safe on the chunk pipeline's import path.
 *
 * The key is deliberately PATH identity, not content identity. The case worth catching is an old
 * generation beside a newer CORRECTED one, so their text differs by definition; a content hash would
 * only ever collapse byte-identical re-uploads and would miss every interesting case. `serverTextHash`
 * grades how CONFIDENTLY two same-identity members can be called equal (see `isFingerprint` and
 * `classifyGroup`) - it is never what decides they are the same document.
 */

/**
 * Which signal produced a key, most to least trustworthy. Reported alongside every match, because
 * the weakest tier is the one that can be wrong: two genuinely different `README.md` files in one
 * lake, neither carrying a `relativePath`, are indistinguishable here.
 */
export const SOURCE_IDENTITY_TIERS = ['driveFileId', 'relativePath', 'fileName'] as const;
export type SourceIdentityTier = (typeof SOURCE_IDENTITY_TIERS)[number];

/** The only three fields the derivation reads. Every caller's richer row structurally satisfies it. */
export interface SourceIdentified {
  fileName?: string | null;
  /** Populated for folder uploads and Drive ingest; absent on a plain single-file re-upload. */
  relativePath?: string | null;
  /** Drive ingest only - its own doc comment calls it the stable dedup key within a lake. */
  driveFileId?: string | null;
}

// NUL-joined, with the scope and the tier literal at fixed positions, so no value can forge a key
// belonging to another scope or another tier. Within one tier the join is not injective if a NUL is
// ever representable in a name (`a` + `b\0c` and `a\0b` + `c` agree), which costs nothing here: same
// scope, and the outcome is at worst one wrong match of the kind the file-name tier already permits.
const SEP = '\0';

/**
 * The identity key for one file within one scope, first applicable tier wins. Null when the file has
 * no usable name at all, which means "matches only itself" - never "matches everything".
 *
 * `scopeKey` is whatever partition the caller is comparing within (a lake id for the collapse, `''`
 * for a set already narrowed to one lake). It is part of the key rather than the caller's problem so
 * that two callers comparing across different partitions cannot accidentally share a key space.
 */
export function sourceIdentityKeyFor(
  file: SourceIdentified,
  scopeKey: string
): { key: string; tier: SourceIdentityTier } | null {
  if (file.driveFileId) {
    return { key: [scopeKey, 'driveFileId', file.driveFileId].join(SEP), tier: 'driveFileId' };
  }
  if (!file.fileName) return null;
  if (file.relativePath) {
    return { key: [scopeKey, 'relativePath', file.relativePath, file.fileName].join(SEP), tier: 'relativePath' };
  }
  return { key: [scopeKey, 'fileName', file.fileName].join(SEP), tier: 'fileName' };
}
