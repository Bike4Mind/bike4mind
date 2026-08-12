/**
 * Length of `text` in Unicode CODE POINTS - the unit `IFabFileChunk.charLength` is stored in.
 * Matches MongoDB's `$strLenCP`, which is what lets the char-length backfill
 * (packages/scripts/datalake/backfill-chunk-char-length.ts) compute the same number server-side
 * without reading chunk text out of the database. Deliberately NOT `text.length` (UTF-16 code
 * units): the two differ on astral characters (surrogate pairs), and the write path and the
 * backfill must agree exactly.
 */
export const countCodePoints = (text: string): number => {
  let count = 0;
  // for..of iterates by code point, so a surrogate pair advances once.
  for (const _ch of text) count++;
  return count;
};
