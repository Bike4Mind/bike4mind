/**
 * Detect a MongoDB duplicate-key error without coupling to a specific
 * driver/Mongoose error class. The runtime `code: 11000` shape is stable
 * across `MongoServerError`, `MongoError`, and Mongoose's `MongooseError`
 * wrappers, so a structural check is the safest cross-version signal.
 *
 * Used by `/api/skills` POST and PUT to surface unique-index violations as
 * a friendly 400 instead of letting a 500 bubble out of the handler, and by
 * the writers that treat a collision as "someone else won the insert"
 * (`persistAgentArtifacts`, `helpFeedbackRouting`).
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as { code?: unknown }).code === 11000) return true;
  // Read `message` off any object, not just an Error instance. A driver error that crossed a
  // serialization boundary arrives as a plain object carrying only the text, and an
  // `instanceof Error` check would miss it - sending a genuine duplicate down the generic failure
  // path, which for the insert-race callers means an unrepaired orphan or a lost comment.
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('E11000');
}
