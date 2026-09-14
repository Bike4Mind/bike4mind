import { describe, it, expect } from 'vitest';
import { isObjectIdShaped } from './objectId';

/**
 * The truth table, pinned. This predicate decides whether caller-controlled, unbounded input is
 * allowed to reach Mongoose's `_id` cast, so the enumeration matters more than any single case -
 * a point fix to the expression moves the boundary somewhere new instead of settling it.
 */
describe('isObjectIdShaped', () => {
  it.each([
    ['a real lowercase ObjectId', '68b0f3a2c1d4e5f60718293a'],
    ['the same id uppercased', '68B0F3A2C1D4E5F60718293A'],
    ['the same id in mixed case', '68b0F3a2C1d4E5f60718293A'],
  ])('accepts %s', (_label, id) => {
    expect(isObjectIdShaped(id)).toBe(true);
  });

  it.each([
    ['a filename token, the shape production actually sent', 'w7154539641'],
    ['an arXiv id lifted from chunk text, dot mangled to a space', '2506 07866'],
    ['a bare filename', 'Handbook.pdf'],
    ['a 12-char string (raw-byte form Mongoose no longer casts)', 'abcdefghijkl'],
    ['one hex digit short', '68b0f3a2c1d4e5f6071829'],
    ['one hex digit long', '68b0f3a2c1d4e5f60718293ab'],
    ['24 non-hex characters', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['a well-formed id with surrounding whitespace', ' 68b0f3a2c1d4e5f60718293a '],
    ['the empty string', ''],
  ])('rejects %s', (_label, id) => {
    expect(isObjectIdShaped(id)).toBe(false);
  });

  it.each([
    ['a number, which isValidObjectId would accept and cast to a fabricated id', 12],
    ['null', null],
    ['undefined', undefined],
    ['an object', { $ne: null }],
  ])('rejects %s', (_label, id) => {
    expect(isObjectIdShaped(id)).toBe(false);
  });

  it('rejects an artifact id, which is matched on a string `id` field and never on `_id`', () => {
    expect(isObjectIdShaped('artifact_chart_revenue_1788929620_0')).toBe(false);
  });

  // Guards the collapse of imageEdit's hand-rolled regex onto this helper: the two agreed on
  // every class above, so that swap was behaviour-preserving. lattice's `/^[a-f0-9]{24}$/` is
  // NOT equivalent - it rejects the uppercase and mixed-case ids asserted above - so it is
  // deliberately left on its own regex rather than widened as a drive-by.
  it('agrees with the case-insensitive 24-hex regex that callers used to hand-roll', () => {
    const handRolled = /^[0-9a-fA-F]{24}$/;
    const cases = [
      '68b0f3a2c1d4e5f60718293a',
      '68B0F3A2C1D4E5F60718293A',
      '68b0F3a2C1d4E5f60718293A',
      'w7154539641',
      '2506 07866',
      'abcdefghijkl',
      '',
      ' 68b0f3a2c1d4e5f60718293a ',
      'Handbook.pdf',
      '68b0f3a2c1d4e5f6071829',
      '68b0f3a2c1d4e5f60718293ab',
    ];
    for (const value of cases) {
      expect({ value, shaped: isObjectIdShaped(value) }).toEqual({ value, shaped: handRolled.test(value) });
    }
  });
});
