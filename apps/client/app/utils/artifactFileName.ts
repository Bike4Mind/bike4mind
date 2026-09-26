const MAX_LENGTH = 80;

/**
 * Builds a safe file name for an artifact save/export. Titles are free-form user or
 * model text, and `${title.toLowerCase().replace(/\s+/g, '_')}` (the pattern this replaces)
 * only strips whitespace - a title containing `/`, `:`, `?`, `*`, `"`, `<`, `>`, `|`, or `\`
 * produced an S3 key path segment or an invalid OS file name.
 */
export function artifactFileName(title: string | undefined | null, ext: string, fallback = 'file'): string {
  const collapsed = (title ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  const trimmed = collapsed.replace(/^[_.]+|[_.]+$/g, '');
  // Re-trim after the length cap: truncation can land mid-run and leave a fresh trailing separator.
  const base = trimmed.slice(0, MAX_LENGTH).replace(/[_.]+$/g, '');
  const name = base || fallback;
  return `${name}_${Date.now()}.${ext}`;
}
