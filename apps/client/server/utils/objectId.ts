import { isObjectIdOrHexString } from 'mongoose';

// `isObjectIdOrHexString`, not a round trip through `new Types.ObjectId(id).toString()`
// (that lowercases, so it rejects a valid uppercase-hex id) and not
// `Types.ObjectId.isValid` (that accepts a number or a 12-byte Buffer and casts it to a
// fabricated id). Same choice, for the same reason, as b4m-core/services/src/utils/objectIds.ts.
// Callers should reject with a 4xx before the value reaches a query: an ObjectId-typed
// filter or update payload casts it and throws a CastError well past the point where a
// 400 was the right answer.
export const isValidObjectId = (id: string): boolean => isObjectIdOrHexString(id);

/**
 * The canonical lowercase form of `id`, or `undefined` when it is not an ObjectId hex
 * string. Use this rather than `isValidObjectId` wherever the validated string is
 * persisted or compared AS A STRING: an ObjectId-typed query casts and so matches any
 * casing, but a `type: String` field does byte equality, and the id a document hands back
 * (the Mongoose `id` virtual) is always lowercase. An uppercase id that skips this
 * silently misses instead of erroring.
 */
export const toObjectIdString = (id: string): string | undefined =>
  isValidObjectId(id) ? String(id).toLowerCase() : undefined;
