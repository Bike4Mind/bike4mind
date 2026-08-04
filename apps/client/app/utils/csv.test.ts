import { describe, expect, it } from 'vitest';
import { escapeCsvCell, toCsv } from './csv';

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
