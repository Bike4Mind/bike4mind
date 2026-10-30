/** Compact date for the Live Artifacts rows and cards: same-year dates drop the year. */
export function shortDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** View counts past 9,999 go compact so a big number cannot outgrow its column. */
export function formatViews(n: number): string {
  return n < 10_000 ? String(n) : new Intl.NumberFormat(undefined, { notation: 'compact' }).format(n);
}

/** Human names for `source.kind`, used by the Type facet chips and the settings panel. The raw
 *  values are storage names ('fabfile') that mean nothing to the person reading the list. */
const SOURCE_KIND_LABEL: Record<string, string> = { bundle: 'Bundle', reply: 'Reply', fabfile: 'File' };

/** The label for a source kind, falling back to the raw value so a kind added server-side still shows. */
export function sourceKindLabel(kind: string): string {
  return Object.hasOwn(SOURCE_KIND_LABEL, kind) ? SOURCE_KIND_LABEL[kind] : kind;
}
