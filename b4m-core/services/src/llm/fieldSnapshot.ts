/**
 * Per-key fingerprints of a document's top-level fields, so a repeated save can `$set` only the keys
 * that changed since the last write. A fingerprint is the value's JSON form: ObjectIds and Dates go
 * through their own `toJSON`, and the snapshot holds strings rather than references, so an in-place
 * mutation of a nested object or array still reads as a change. `null` marks a value that cannot be
 * serialized (a cycle, a BigInt); it never compares equal, so that key is always written.
 */
export type FieldSnapshot = ReadonlyMap<string, string | null>;

const mapsAsObjects = (_key: string, value: unknown) => (value instanceof Map ? Object.fromEntries(value) : value);

function fingerprint(value: unknown): string | null | undefined {
  try {
    return JSON.stringify(value, mapsAsObjects);
  } catch {
    return null;
  }
}

/**
 * The top-level fields of `doc` that differ from `previous` (all of them when there is no previous
 * snapshot), and the snapshot to keep once they are written. Keys in `omit` are never returned.
 * An `undefined` value counts as absent, and a key that disappeared is not reported: neither can be
 * expressed through `$set`, so the stored value stays as it was.
 */
export function diffFields<T extends object>(
  doc: T,
  previous: FieldSnapshot | undefined,
  omit: ReadonlySet<string>
): { changed: Partial<T>; snapshot: FieldSnapshot } {
  const changed: Record<string, unknown> = {};
  const snapshot = new Map<string, string | null>();
  for (const [key, value] of Object.entries(doc)) {
    if (omit.has(key)) continue;
    const print = fingerprint(value);
    if (print === undefined) continue;
    snapshot.set(key, print);
    if (print === null || previous?.get(key) !== print) changed[key] = value;
  }
  return { changed: changed as Partial<T>, snapshot };
}
