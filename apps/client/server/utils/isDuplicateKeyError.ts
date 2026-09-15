/**
 * Detect a MongoDB duplicate-key error without coupling to a specific
 * driver/Mongoose error class. The runtime `code: 11000` shape is stable
 * across `MongoServerError`, `MongoError`, and Mongoose's `MongooseError`
 * wrappers, so a structural check is the safest cross-version signal.
 *
 * Used by `/api/skills` POST and PUT to surface unique-index violations as
 * a friendly 400 instead of letting a 500 bubble out of the handler.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 11000;
}
