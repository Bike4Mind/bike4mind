import { describe, expect, it } from 'vitest';
import { parseCsvFirstColumn, parseEmailList } from './bulkInviteParse';

describe('parseEmailList', () => {
  it('splits on whitespace, commas and semicolons and drops blanks', () => {
    expect(parseEmailList('a@x.com, b@x.com;c@x.com\n\n  d@x.com\t')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(parseEmailList('  \n\t ')).toEqual([]);
  });

  it('extracts the address from Name <addr> entries', () => {
    expect(parseEmailList('Ann Smith <ann@x.com>')).toEqual(['ann@x.com']);
    expect(parseEmailList('Ann <a@x.com>, Bob <b@y.com>')).toEqual(['a@x.com', 'b@y.com']);
    expect(parseEmailList('Ann <a@x.com>\nBob <b@y.com>; <c@z.com>')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('drops a quoted display name that contains a comma', () => {
    expect(parseEmailList('"Smith, Ann" <ann@x.com>, bare@x.com')).toEqual(['ann@x.com', 'bare@x.com']);
  });

  it('drops a quoted display name with a comma after a separator and space', () => {
    expect(parseEmailList('bare@x.com, "Smith, Ann" <ann@x.com>;\t"Lee, Bo" <bo@x.com>')).toEqual([
      'bare@x.com',
      'ann@x.com',
      'bo@x.com',
    ]);
  });

  it('mixes bare and angle-bracket addresses and keeps an unclosed < as a plain token', () => {
    expect(parseEmailList('a@x.com Bob <b@y.com> c@x.com')).toEqual(['a@x.com', 'b@y.com', 'c@x.com']);
    expect(parseEmailList('a@x.com <oops')).toEqual(['a@x.com', '<oops']);
  });

  it('stays fast on a long run of brackets', () => {
    const start = Date.now();
    expect(parseEmailList('<a@x.com>'.repeat(50000))).toHaveLength(50000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('strips a leading byte order mark', () => {
    expect(parseEmailList('\uFEFFa@x.com')).toEqual(['a@x.com']);
  });
});

describe('parseCsvFirstColumn', () => {
  it('takes the first column and skips a header row without an @', () => {
    expect(parseCsvFirstColumn('email,name\na@x.com,Ann\nb@x.com,Bob\n')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('keeps the first row when it is an address', () => {
    expect(parseCsvFirstColumn('a@x.com,Ann\r\nb@x.com,Bob')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('strips a BOM before the header check', () => {
    expect(parseCsvFirstColumn('\uFEFFEmail\na@x.com')).toEqual(['a@x.com']);
  });

  it('reads quoted cells, including a comma and an escaped quote inside them', () => {
    expect(parseCsvFirstColumn('"a@x.com",Ann\n"b,""q""@x.com",Bob')).toEqual(['a@x.com', 'b,"q"@x.com']);
  });

  it('ignores blank lines and empty first cells', () => {
    expect(parseCsvFirstColumn('a@x.com\n\n   \n,Nobody\nb@x.com')).toEqual(['a@x.com', 'b@x.com']);
  });
});
