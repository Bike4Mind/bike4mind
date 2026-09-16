import { isObjectIdOrHexString } from 'mongoose';

// `isObjectIdOrHexString`, not a round trip through `new Types.ObjectId(id).toString()`
// (that lowercases, so it rejects a valid uppercase-hex id) and not
// `Types.ObjectId.isValid` (that accepts a number or a 12-byte Buffer and casts it to a
// fabricated id). Same choice, for the same reason, as b4m-core/services/src/utils/objectIds.ts.
// Callers must check before the value reaches a query: an ObjectId-typed filter or update
// payload casts it and throws a CastError from deep inside the driver, well past the point
// where the route could answer for itself. For a path/query resource id that check is the
// route's own 404 - see the status table in b4m-core/common/src/api-contract/CONVENTIONS.md.
//
// Takes `unknown` because a Next.js route param is `string | string[] | undefined`: a
// non-string can never be a hex id, and narrowing here beats `String(id)` at each call site,
// which would turn `undefined` into the literal 'undefined'. Returns a type predicate so the
// narrowed value still composes with the `string` signatures below.
export const isValidObjectId = (id: unknown): id is string => isObjectIdOrHexString(id);

/**
 * The canonical lowercase form of `id`, or `undefined` when it is not an ObjectId hex
 * string. Use this rather than `isValidObjectId` wherever the validated string is
 * persisted or compared AS A STRING: an ObjectId-typed query casts and so matches any
 * casing, but a `type: String` field does byte equality, and the id a document hands back
 * (the Mongoose `id` virtual) is always lowercase. An uppercase id that skips this
 * silently misses instead of erroring.
 */
export const toObjectIdString = (id: string): string | undefined =>
  isValidObjectId(id) ? id.toLowerCase() : undefined;
