/**
 * Pure id-shape helpers for the unaddressable-fabfilechunk sweep
 * (20260911120000_delete-unaddressable-fabfilechunks.ts and its preview script). No I/O, so the
 * two gates that decide an irreversible delete are unit-testable without a Mongo connection.
 */

/** Gate 1, client side. Also the server-side bound - see the note on PCRE `$` in scanUnaddressableChunks. */
export const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/**
 * OVERLAPPING by construction. A non-overlapping `/[0-9a-fA-F]{24}/g` is left-greedy: a real id
 * glued to a hex run whose length is not a multiple of 24 is never extracted, so gate 2 would
 * report "nothing resolvable here" and the row would be deleted despite its file existing. The
 * lookahead makes every 24-character window a candidate instead.
 */
const EMBEDDED_OBJECT_ID = /(?=([0-9a-fA-F]{24}))/g;

/**
 * Every 24-hex window in the value, lowercased. Deliberately generous: a spurious candidate can
 * only keep a row, never delete one.
 *
 * Lowercasing is gate 2's whole correctness condition, not tidying. The candidates are compared
 * against `String(doc._id)` from a lookup, and BSON always renders an ObjectId lowercase, so a
 * mixed-case candidate would miss a file the `$in` lookup had just found - confirming the file
 * exists and then deleting the chunk anyway.
 */
export const extractEmbeddedObjectIds = (value: string): string[] => [
  ...new Set([...value.matchAll(EMBEDDED_OBJECT_ID)].map(m => m[1].toLowerCase())),
];
