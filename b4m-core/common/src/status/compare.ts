/** Locale-independent ordering for slugs, ids and timestamps. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders timestamps by parsed epoch, falling back to the raw strings when either is unparseable. */
export function cmpTime(a: string, b: string): number {
  const x = Date.parse(a);
  const y = Date.parse(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x < y ? -1 : 1;
  return Number.isFinite(x) && Number.isFinite(y) ? 0 : cmpStr(a, b);
}
