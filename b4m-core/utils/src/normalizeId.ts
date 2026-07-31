/**
 * Coerce an id-ish value to its primitive string form, or `undefined` when absent.
 *
 * Handles the three shapes a Mongo id arrives in across request layers: a plain string,
 * a Mongo `ObjectId` (via `toHexString`), and a populated Mongoose document (`{ _id }` /
 * `{ id }`). Plain `String()` is NOT enough - it turns a populated document into
 * "[object Object]", which is exactly the silent-comparison trap that lets a value match a
 * casting Mongo query yet fail an in-memory strict `===`/`!==`. Normalize both sides of any
 * such comparison through this so the two never disagree.
 */
export function normalizeId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // ObjectId (and Mongoose ObjectId) exposes toHexString() - the exact hex string.
    if (typeof obj.toHexString === 'function') return (obj.toHexString as () => string)() || undefined;
    // Populated document: prefer its ObjectId `_id` (recurse), then a virtual `id` getter.
    if (obj._id != null) return normalizeId(obj._id);
    if (typeof obj.id === 'string') return obj.id || undefined;
  }
  const s = String(value);
  return s && s !== '[object Object]' ? s : undefined;
}
