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
 * lake, neither sitting under a folder, are indistinguishable here.
 *
 * `relativePath` therefore means "under the same folder", not merely "carries a relativePath field"
 * - most uploads carry the field with nothing but the file name in it.
 */
export const SOURCE_IDENTITY_TIERS = ['driveFileId', 'relativePath', 'fileName'] as const;
export type SourceIdentityTier = (typeof SOURCE_IDENTITY_TIERS)[number];

/** The only three fields the derivation reads. Every caller's richer row structurally satisfies it. */
export interface SourceIdentified {
  fileName?: string | null;
  /**
   * Populated for folder uploads and Drive ingest. NOT a reliable "has a folder" signal: the lake
   * wizard's flat picker fills it with `webkitRelativePath || file.name`, so an ordinary single-file
   * upload carries its own bare name here, and producers disagree on whether the path includes the
   * file name at all. Only the folder it resolves to is ever read - see `folderKeyOf`.
   */
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
 * The FOLDER a relativePath denotes, or null when it denotes none.
 *
 * Three spellings are in circulation and they cannot be told apart by shape alone:
 *   - `docs/README.md` - the path INCLUDING the file name (folderTreeParser, the Drive walk)
 *   - `docs` or `docs/` - the directory only
 *   - `README.md` - the file name and nothing else, which is NOT a folder
 *
 * The last one is why this function exists. The lake wizard's flat picker sets
 * `relativePath = webkitRelativePath || file.name`, so an ordinary single-file upload arrives
 * carrying its own bare name as a "path". Reading that as folder evidence reported the strong tier
 * for the weakest possible match AND, worse, gave one document two key spaces - a file admitted
 * through the flat picker could never group with the same file admitted through a door that sets no
 * relativePath (chat attach), so a real duplicate pair went undetected.
 *
 * A separator test cannot separate case 2 from case 3: `docs` and `README.md` both have none. The
 * discriminator is the file name - if the path's last segment IS the file name, the path denotes the
 * file and the folder is whatever precedes it; otherwise the path denotes the directory. That also
 * makes the first two spellings agree, which they must, since they mean the same document.
 *
 * The server's taxonomy step already treats a relativePath that resolves to no folder as
 * contributing no folder tags (generate-presigned-urls-batch.ts), so this is the same rule read in
 * one more place.
 *
 * Exported (not just used by sourceIdentityKeyFor below) so a THIRD reader - a corpus-shape report
 * that groups lake members by folder - resolves the same folder a fourth private copy would drift
 * from. That is the exact failure this module was extracted to stop.
 */
export function folderKeyOf(relativePath: string, fileName: string): string | null {
  // A trailing separator carries no information: `docs/` and `docs` are one folder.
  const path = relativePath.replace(/\/+$/, '');
  const lastSeparator = path.lastIndexOf('/');
  const denotesTheFileItself = path.slice(lastSeparator + 1) === fileName;
  // Math.max guards the no-separator case, where slice(0, -1) would drop a real folder's last char.
  const folder = denotesTheFileItself ? path.slice(0, Math.max(lastSeparator, 0)) : path;
  return folder || null;
}

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
  const folder = file.relativePath ? folderKeyOf(file.relativePath, file.fileName) : null;
  if (folder) {
    return { key: [scopeKey, 'relativePath', folder, file.fileName].join(SEP), tier: 'relativePath' };
  }
  return { key: [scopeKey, 'fileName', file.fileName].join(SEP), tier: 'fileName' };
}
