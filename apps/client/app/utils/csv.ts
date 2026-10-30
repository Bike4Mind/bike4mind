import dayjs from 'dayjs';
import { SLACK_CSV_FORMULA_PREFIX } from '@bike4mind/server-utils/integrations/slack/slackExportCsv';

/** Leading characters that make a spreadsheet evaluate a cell as a formula. */
export const CSV_FORMULA_PREFIX = SLACK_CSV_FORMULA_PREFIX;

/**
 * Escapes one CSV cell for spreadsheet import.
 *
 * Beyond RFC 4180 quoting this also defuses formula injection: a cell starting with =, +, -, @,
 * tab or CR is evaluated as a formula by Excel and Google Sheets, so exported user-supplied text
 * (display names, organization names) could run on the machine of whoever opens the file. Such
 * values get an apostrophe prefix, which spreadsheets strip on display.
 *
 * Every field is quoted rather than only the ones that need it - valid CSV, and one less rule to
 * get wrong. Newlines are flattened to spaces so a row always occupies a single line.
 */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const flattened = text.replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""');
  const guarded = CSV_FORMULA_PREFIX.test(flattened) ? `'${flattened}` : flattened;
  return `"${guarded}"`;
}

/** Joins rows of already-raw values into a CSV document, escaping every cell. */
export function toCsv(rows: unknown[][]): string {
  return rows.map(row => row.map(escapeCsvCell).join(',')).join('\n');
}

const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Serializes one value as an RFC 4180 CSV field; string cells that start like a formula are neutralized.
 * Unlike escapeCsvCell it quotes only when needed and keeps newlines.
 */
export const toCsvCell = (value: unknown, dateFormat = 'YYYY-MM-DD'): string => {
  if (value === null || value === undefined) return '';
  if (dayjs.isDayjs(value)) return value.format(dateFormat);
  if (value instanceof Date) return dayjs(value).format(dateFormat);

  let text: string;
  if (typeof value === 'string') {
    text = value;
    // OWASP CSV-injection guard: spreadsheets evaluate cells starting with these characters.
    if (CSV_FORMULA_PREFIX.test(text)) text = `'${text}`;
  } else if (typeof value === 'object') {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** Record-based counterpart of toCsv: picks `columns` from each row and joins with CRLF. */
export const toCsvFromRecords = (
  rows: Record<string, unknown>[],
  columns: string[],
  dateFormat = 'YYYY-MM-DD'
): string =>
  [
    columns.map(column => toCsvCell(column)),
    ...rows.map(row => columns.map(column => toCsvCell(row[column], dateFormat))),
  ]
    .map(cells => cells.join(','))
    .join('\r\n');

// Excel only decodes a CSV as UTF-8 when it starts with a byte-order mark.
export const CSV_BOM = '\uFEFF';
