import { Types } from 'mongoose';

// Round-trip rather than mongoose.isValidObjectId, which also accepts any 12-character
// string and would let a junk id through as a silent no-match. Callers should reject with
// a 400 before the value reaches a query: an ObjectId-typed filter OR update payload casts
// it and throws, and errorHandler only maps a cast on `_id` back to a 404.
export const isValidObjectId = (id: string): boolean =>
  Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
