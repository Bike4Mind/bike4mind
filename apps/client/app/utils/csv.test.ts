import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { CSV_FORMULA_PREFIX, escapeCsvCell, toCsv, toCsvCell, toCsvFromRecords } from './csv';

describe('escapeCsvCell', () => {
  it('quotes every value so callers never have to decide', () => {
    expect(escapeCsvCell('Ada')).toBe('"Ada"');
  });

  it('keeps a value containing a comma in one field', () => {
    expect(escapeCsvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
  });

  it('doubles embedded quotes', () => {
    expect(escapeCsvCell('Ada "The Enchantress" Lovelace')).toBe('"Ada ""The Enchantress"" Lovelace"');
  });

  it('flattens newlines so a row stays on one line', () => {
    expect(escapeCsvCell('line one\r\nline two\rline three\nline four')).toBe(
      '"line one line two line three line four"'
    );
  });

  it.each(['=HYPERLINK("http://evil/")', '+1234', '-1234', '@SUM(A1)', '\tstartsWithTab'])(
    'defuses the formula-injection prefix in %j',
    value => {
      expect(escapeCsvCell(value)).toBe(`"'${value.replace(/"/g, '""')}"`);
    }
  );

  it('leaves a leading CR harmless by flattening it to a space before the guard', () => {
    // Not apostrophe-prefixed, and does not need to be: a leading space stops Excel and Sheets
    // evaluating the cell. This pins the flatten-then-guard order the guard depends on.
    expect(escapeCsvCell('\r=SUM(A1)')).toBe('" =SUM(A1)"');
  });

  it('renders null and undefined as empty cells', () => {
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it('stringifies non-string scalars', () => {
    expect(escapeCsvCell(0)).toBe('"0"');
    expect(escapeCsvCell(false)).toBe('"false"');
  });
});

describe('toCsv', () => {
  it('escapes every cell and joins rows with newlines', () => {
    expect(
      toCsv([
        ['Name', 'Org'],
        ['Lovelace, Ada', undefined],
      ])
    ).toBe('"Name","Org"\n"Lovelace, Ada",""');
  });
});

describe('escapeCsvCell edge cases', () => {
  it('escapes a header cell the same way as a body cell', () => {
    expect(toCsv([['=Name'], ['Ada']])).toBe(`"'=Name"\n"Ada"`);
  });

  it('does not prefix a cell with a leading space', () => {
    expect(escapeCsvCell(' =1')).toBe('" =1"');
  });
});

describe('CSV_FORMULA_PREFIX', () => {
  it.each(['=1', '+1', '-1', '@a', '\ta', '\ra'])('matches %j', value => {
    expect(CSV_FORMULA_PREFIX.test(value)).toBe(true);
  });

  it('does not match ordinary text', () => {
    expect(CSV_FORMULA_PREFIX.test('Ada')).toBe(false);
  });
});

describe('toCsvCell', () => {
  it('doubles inner quotes and wraps the field', () => {
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps fields containing commas', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
  });

  it('wraps fields containing LF or CRLF', () => {
    expect(toCsvCell('a\nb')).toBe('"a\nb"');
    expect(toCsvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it('escapes JSON metadata strings and objects', () => {
    expect(toCsvCell('{"reportId":"x"}')).toBe('"{""reportId"":""x""}"');
    expect(toCsvCell({ reportId: 'x' })).toBe('"{""reportId"":""x""}"');
  });

  it.each(['=SUM(A1)', '+1', '-1+2', '@cmd', '\tx', '\rx'])('prefixes formula-like string %j', input => {
    expect(toCsvCell(input).replace(/^"|"$/g, '').startsWith("'")).toBe(true);
  });

  it('puts the formula prefix inside the quotes when a field needs both', () => {
    expect(toCsvCell('=a,b')).toBe(`"'=a,b"`);
    expect(toCsvCell('=say "x"')).toBe(`"'=say ""x"""`);
  });

  it('leaves numbers and booleans untouched, including negatives', () => {
    expect(toCsvCell(-5)).toBe('-5');
    expect(toCsvCell(3.5)).toBe('3.5');
    expect(toCsvCell(false)).toBe('false');
  });

  it('renders null and undefined as empty', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
  });

  it('formats Date instances with the given format', () => {
    expect(toCsvCell(new Date(2025, 2, 4, 10, 30), 'YYYY-MM-DD HH:mm')).toBe('2025-03-04 10:30');
  });

  it('emits ISO-looking strings verbatim', () => {
    expect(toCsvCell('2025-01-01 note')).toBe('2025-01-01 note');
  });

  it('formats Dayjs instances with the given format', () => {
    expect(toCsvCell(dayjs('2025-03-04T10:30:00'), 'YYYY-MM-DD HH:mm')).toBe('2025-03-04 10:30');
  });
});

describe('toCsvFromRecords', () => {
  it('emits an escaped header row followed by data rows', () => {
    const csv = toCsvFromRecords(
      [
        { a: 'x,y', b: -2 },
        { a: '=1', b: null },
      ],
      ['a', 'b']
    );
    expect(csv).toBe(['a,b', '"x,y",-2', "'=1,"].join('\r\n'));
  });

  it('escapes header names', () => {
    expect(toCsvFromRecords([{ 'a,b': 1 }], ['a,b'])).toBe('"a,b"\r\n1');
  });
});
