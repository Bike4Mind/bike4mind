const MAX_LENGTH = 80;

/**
 * Builds a safe file name for an artifact save/export. Titles are free-form user or
 * model text, and `${title.toLowerCase().replace(/\s+/g, '_')}` (the pattern this replaces)
 * only strips whitespace - a title containing `/`, `:`, `?`, `*`, `"`, `<`, `>`, `|`, or `\`
 * produced an S3 key path segment or an invalid OS file name.
 *
 * The keep-set is Unicode letters/digits (`\p{L}`/`\p{N}`), not the ASCII `a-z0-9` this
 * replaces - the ASCII-only class wiped a CJK or accented title down to bare separators,
 * losing the title entirely and leaving only `fallback`.
 */
export function artifactFileName(title: string | undefined | null, ext: string, fallback = 'file'): string {
  const collapsed = (title ?? '').toLowerCase().replace(/[^\p{L}\p{N}._-]+/gu, '_');
  const trimmed = collapsed.replace(/^[_.]+|[_.]+$/g, '');
  // Re-trim after the length cap: truncation can land mid-run and leave a fresh trailing separator.
  const base = trimmed.slice(0, MAX_LENGTH).replace(/[_.]+$/g, '');
  const name = base || fallback;
  return `${name}_${Date.now()}.${ext}`;
}
