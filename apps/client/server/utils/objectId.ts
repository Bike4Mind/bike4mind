// A 24-character hex string is exactly what Mongoose will cast to an ObjectId. Matching the
// hex directly rather than round-tripping through `new Types.ObjectId(id).toString()`, which
// lowercases and so would reject a valid uppercase-hex id.
// Callers should reject with a 4xx before the value reaches a query: an ObjectId-typed
// filter OR update payload casts it and throws, and errorHandler only maps a cast on `_id`
// back to a 404.
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

export const isValidObjectId = (id: string): boolean => OBJECT_ID_HEX.test(id);
