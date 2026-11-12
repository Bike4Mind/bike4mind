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
