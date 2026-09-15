/**
 * Escapes one CSV cell for spreadsheet import.
 *
 * Beyond RFC 4180 quoting this also defuses formula injection: a cell starting with =, +, -, @
 * or tab is evaluated as a formula by Excel and Google Sheets, so exported user-supplied text
 * (display names, organization names) could run on the machine of whoever opens the file. Such
 * values get an apostrophe prefix, which spreadsheets strip on display.
 *
 * Every field is quoted rather than only the ones that need it - valid CSV, and one less rule to
 * get wrong. Newlines are flattened to spaces so a row always occupies a single line.
 *
 * Order matters: flattening runs first, so a leading CR arrives at the guard as a space and needs
 * no entry in the character class. Swap those two lines and CR becomes a real hole.
 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const flattened = text.replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
  const guarded = /^[=+\-@\t]/.test(flattened) ? `'${flattened}` : flattened;
  return `"${guarded}"`;
}

/** Joins rows of already-raw values into a CSV document, escaping every cell. */
export function toCsv(rows: unknown[][]): string {
  return rows.map(row => row.map(escapeCsvCell).join(',')).join('\n');
}
