/**
 * Saved-view matching shared by every admin list (the audit log's views, the users list's built-in
 * and saved views). A view is its values, not a stored id, so a shared link or a hand-set filter
 * that equals a view lights that view up too.
 */

export type SavedViewValues = Readonly<Record<string, unknown>>;

const sameValue = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((item, index) => item === b[index]) : a === b;

/**
 * Whether `a` and `b` agree on `keys` (default: every key either has). An absent key equals
 * undefined, and arrays compare item by item, in order.
 */
export function sameViewValues(a: SavedViewValues, b: SavedViewValues, keys?: readonly string[]): boolean {
  const compared = keys ?? [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return compared.every(key => sameValue(a[key], b[key]));
}

/** The first of `views` whose values equal `current` on `keys`, if any. */
export function matchSavedView<View>(
  views: readonly View[],
  current: SavedViewValues,
  valuesOf: (view: View) => SavedViewValues,
  keys?: readonly string[]
): View | undefined {
  return views.find(view => sameViewValues(valuesOf(view), current, keys));
}
