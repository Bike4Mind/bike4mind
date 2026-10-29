import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { toCsv, toCsvCell } from './useExportToCSV';

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

  it('formats ISO dates', () => {
    expect(toCsvCell('2025-03-04T10:00:00')).toBe('2025-03-04');
  });

  it('formats Dayjs instances with the given format', () => {
    expect(toCsvCell(dayjs('2025-03-04T10:30:00'), 'YYYY-MM-DD HH:mm')).toBe('2025-03-04 10:30');
  });
});

describe('toCsv', () => {
  it('emits an escaped header row followed by data rows', () => {
    const csv = toCsv(
      [
        { a: 'x,y', b: -2 },
        { a: '=1', b: null },
      ],
      ['a', 'b']
    );
    expect(csv).toBe(['a,b', '"x,y",-2', "'=1,"].join('\r\n'));
  });

  it('escapes header names', () => {
    expect(toCsv([{ 'a,b': 1 }], ['a,b'])).toBe('"a,b"\r\n1');
  });
});
