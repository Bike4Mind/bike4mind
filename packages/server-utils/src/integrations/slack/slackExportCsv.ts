/** Leading characters that make a spreadsheet evaluate a cell as a formula. Also re-exported by apps/client/app/utils/csv.ts. */
export const SLACK_CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Escapes one Slack-export CSV field: formula-prefixed cells get a leading apostrophe, quotes are
 * doubled, and newlines become literal `\n` / `\r`. Shared by the sync export route and the
 * background export worker so both produce the same file.
 */
export function escapeCsvField(field: string): string {
  if (!field) return '';

  if (SLACK_CSV_FORMULA_PREFIX.test(field)) {
    field = "'" + field;
  }

  return field.replace(/"/g, '""').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
