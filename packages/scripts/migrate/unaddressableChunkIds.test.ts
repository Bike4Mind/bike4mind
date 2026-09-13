import { describe, it, expect } from 'vitest';
import { extractEmbeddedObjectIds, OBJECT_ID_HEX } from './unaddressableChunkIds';

const ID = '507f1f77bcf86cd799439011';

describe('OBJECT_ID_HEX', () => {
  it('accepts a 24-hex id in either case and rejects near-misses', () => {
    expect(OBJECT_ID_HEX.test(ID)).toBe(true);
    expect(OBJECT_ID_HEX.test(ID.toUpperCase())).toBe(true);
    expect(OBJECT_ID_HEX.test(ID.slice(0, 23))).toBe(false);
    expect(OBJECT_ID_HEX.test(`${ID}a`)).toBe(false);
    expect(OBJECT_ID_HEX.test('zzzzzzzzzzzzzzzzzzzzzzzz')).toBe(false);
  });
});

describe('extractEmbeddedObjectIds', () => {
  it('pulls the id out of the observed serialized-document shape', () => {
    expect(extractEmbeddedObjectIds(`{ _id: new ObjectId("${ID}"), fileName: 'contract.pdf' }`)).toEqual([ID]);
  });

  it('lowercases, so a candidate can match a BSON-rendered _id', () => {
    // The whole of gate 2: the $in lookup normalizes case and finds the file, so a candidate left
    // in raw case would miss the resolvable set and the row would be deleted anyway.
    expect(extractEmbeddedObjectIds(`{ _id: new ObjectId("${ID.toUpperCase()}") }`)).toEqual([ID]);
  });

  it('finds an id glued to a hex run that does not align to 24 characters', () => {
    // A non-overlapping match is left-greedy and would yield only 'abc' + the first 21 characters,
    // never the id itself - so gate 2 would clear a row whose file exists.
    expect(extractEmbeddedObjectIds(`abc${ID}`)).toContain(ID);
  });

  it('yields every distinct window of a longer hex run', () => {
    expect(extractEmbeddedObjectIds(`0${'a'.repeat(24)}`)).toEqual([`0${'a'.repeat(23)}`, 'a'.repeat(24)]);
  });

  it('finds nothing in a run shorter than 24 hex characters', () => {
    expect(extractEmbeddedObjectIds(ID.slice(0, 23))).toEqual([]);
  });

  it('finds nothing in a 24-character non-hex string', () => {
    expect(extractEmbeddedObjectIds('zzzzzzzzzzzzzzzzzzzzzzzz')).toEqual([]);
  });

  it('finds nothing in an empty value', () => {
    expect(extractEmbeddedObjectIds('')).toEqual([]);
  });

  it('deduplicates a value that embeds the same id twice', () => {
    expect(extractEmbeddedObjectIds(`${ID} and again ${ID}`)).toEqual([ID]);
  });
});
