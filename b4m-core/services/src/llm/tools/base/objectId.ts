import { isObjectIdOrHexString } from 'mongoose';

/**
 * Is this value shaped like something Mongoose can cast to an `_id`?
 *
 * Tool arguments are composed by the model out of conversation text and reach us as unvalidated
 * JSON, so an id parameter routinely holds something that is not an id at all - a filename token,
 * an arXiv number, a bare integer. Mongoose casts `_id` and throws a CastError on those, which a
 * generic catch upstream then reports as an outage rather than the bad argument it is (#2530).
 * Call this before handing a model-supplied id to `findById` and answer a false the same way the
 * surface answers a genuinely missing row.
 *
 * `isObjectIdOrHexString`, not `isValidObjectId`: the latter also accepts a number and casts it to
 * a fabricated id, and a model emitting `{"file_id": 12}` gives us exactly that despite the
 * `string` type. Same choice, same reason, as `usableObjectIds` in @bike4mind/db-core, which is
 * the array-shaped version of this check.
 *
 * NOT usable for artifact ids (`artifact_<...>`), which are matched on a string `id` field rather
 * than `_id` - see `createArtifactId` in @bike4mind/common.
 */
export function isObjectIdShaped(id: unknown): boolean {
  return isObjectIdOrHexString(id);
}
