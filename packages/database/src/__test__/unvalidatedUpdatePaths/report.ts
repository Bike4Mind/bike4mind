import { readFileSync } from 'node:fs';
import type { Constraint } from './scan';

/** What actually stops an out-of-constraint value reaching the path. See UNVALIDATED_UPDATE_PATHS.md. */
export type Gate = 'schema' | 'repository-check' | 'route-schema' | 'none';

export const GATES: readonly Gate[] = ['schema', 'repository-check', 'route-schema', 'none'];

/** `ref` of a `repository-check` row whose writer only ever stores source literals. */
export const LITERAL_REF = 'literal';
/** `ref` of a `schema` row whose update call passes `runValidators`. */
export const RUN_VALIDATORS_REF = 'runValidators';

export interface ReportRow {
  model: string;
  path: string;
  constraints: Constraint[];
  writer: string;
  gate: Gate;
  ref: string;
  note: string;
}

const HEADER = ['Model', 'Path', 'Constraint', 'Writer', 'Gate', 'Ref', 'Note'];

const unquote = (cell: string) => cell.trim().replace(/^`(.*)`$/, '$1');

/** Parses the inventory table out of the checked-in report. */
export function parseReport(file: string): ReportRow[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(line => line.startsWith('| Model |'));
  if (start < 0) throw new Error(`${file}: inventory table header not found`);
  const header = lines[start]!.split('|')
    .slice(1, -1)
    .map(cell => cell.trim());
  if (header.join() !== HEADER.join()) throw new Error(`${file}: unexpected header ${header.join()}`);

  const rows: ReportRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const [model, path, constraint, writer, gate, ref, note] = line.split('|').slice(1, -1).map(unquote);
    if (!GATES.includes(gate as Gate)) throw new Error(`${file}: unknown gate "${gate}" in: ${line}`);
    rows.push({
      model: model!,
      path: path!,
      constraints: constraint!.split(',').map(c => c.trim()) as Constraint[],
      writer: writer!,
      gate: gate as Gate,
      ref: ref ?? '',
      note: note ?? '',
    });
  }
  return rows;
}

export function formatRow(row: ReportRow): string {
  const ref = row.ref ? `\`${row.ref}\`` : '';
  return `| ${row.model} | \`${row.path}\` | ${row.constraints.join(',')} | \`${row.writer}\` | ${row.gate} | ${ref} | ${row.note} |`;
}

export const rowKey = (row: { model: string; path: string; writer: string }) =>
  `${row.model}|${row.path}|${row.writer}`;
