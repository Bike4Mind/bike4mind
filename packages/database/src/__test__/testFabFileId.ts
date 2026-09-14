/**
 * A readable label as a valid ObjectId string. `FabFileChunk.fabFileId` is format-validated, so a
 * test that wants a legible file id ('in-scope', 'f1') has to spell it as 24 hex characters.
 * Deterministic, so the same label is the same id across a suite. Labels must be distinct within
 * their first 12 bytes.
 */
export const testFabFileId = (label: string) => Buffer.from(label).toString('hex').padEnd(24, '0').slice(0, 24);
