import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';
import * as barrel from '../../index';
import { setupMongoTest } from '../utils';
import { formatRow, LITERAL_REF, parseReport, RUN_VALIDATORS_REF, rowKey, type ReportRow } from './report';
import { collectConstrainedPaths, resolveModels, scanUpdateWrites, type ScannedWrite } from './scan';

/**
 * Guard for UNVALIDATED_UPDATE_PATHS.md: every constrained schema path a literal update call in
 * src/models writes, and the gate that actually protects it. The report is re-derived from source on
 * every run, so this fails when a writer loses its gate (drops `runValidators`, starts passing a
 * runtime value where it stored a literal, a hook stops rejecting) and when a new writer of a
 * constrained path appears without a report row.
 */

const MODELS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../models');
const REPORT = join(MODELS_ROOT, 'UNVALIDATED_UPDATE_PATHS.md');

type Literal = NonNullable<ScannedWrite['literalValues']>[number];

function resolveSchemaType(schema: mongoose.Schema, path: string): mongoose.SchemaType | undefined {
  const direct = schema.path(path);
  if (direct) return direct;
  const segments = path.split('.');
  for (let i = segments.length - 1; i > 0; i--) {
    const nested = (schema.path(segments.slice(0, i).join('.')) as { schema?: mongoose.Schema } | undefined)?.schema;
    if (nested) return resolveSchemaType(nested, segments.slice(i).join('.'));
  }
  return undefined;
}

const limit = (option: unknown): unknown => (Array.isArray(option) ? option[0] : option);

/** Why `value` violates `schemaType`'s constraints, or undefined when it passes. */
function violation(schemaType: mongoose.SchemaType, value: Literal): string | undefined {
  if (value == null) return undefined;
  const caster = (schemaType as unknown as { caster?: mongoose.SchemaType }).caster;
  const options = { ...(caster?.options ?? {}), ...(schemaType.options as Record<string, unknown>) };
  const enumOption = options.enum as unknown;
  if (enumOption != null) {
    const values = Array.isArray(enumOption)
      ? enumOption
      : ((enumOption as { values?: unknown[] }).values ?? Object.values(enumOption as object));
    if (values.length > 0 && !values.includes(value)) return `not in enum [${values.join(', ')}]`;
  }
  if (typeof value === 'string') {
    const max = limit(options.maxlength);
    if (typeof max === 'number' && value.length > max) return `longer than maxlength ${max}`;
    const min = limit(options.minlength);
    if (typeof min === 'number' && value.length < min) return `shorter than minlength ${min}`;
    const match = limit(options.match);
    if (match instanceof RegExp && !match.test(value)) return `does not match ${match}`;
  }
  if (typeof value === 'number') {
    const min = limit(options.min);
    if (typeof min === 'number' && value < min) return `below min ${min}`;
    const max = limit(options.max);
    if (typeof max === 'number' && value > max) return `above max ${max}`;
  }
  return undefined;
}

/** A value the schema refuses, for proving a hook gate still rejects. */
function invalidValueFor(schemaType: mongoose.SchemaType): string | number {
  const options = schemaType.options as Record<string, unknown>;
  if (options.enum != null) return '__not_a_valid_enum_value__';
  const maxlength = limit(options.maxlength);
  if (typeof maxlength === 'number') return 'x'.repeat(maxlength + 1);
  const max = limit(options.max);
  if (typeof max === 'number') return max + 1;
  const min = limit(options.min);
  if (typeof min === 'number') return min - 1;
  throw new Error(`no invalid value generator for ${schemaType.path}`);
}

describe('unvalidated update paths inventory', () => {
  let scanned: ScannedWrite[];
  let report: ReportRow[];

  beforeAll(() => {
    const constrained = collectConstrainedPaths();
    scanned = scanUpdateWrites(MODELS_ROOT, MODELS_ROOT, constrained, resolveModels(barrel as Record<string, unknown>));
    report = parseReport(REPORT);
  });

  const suggestedRow = (write: ScannedWrite): string =>
    formatRow({
      model: write.model,
      path: write.path,
      constraints: write.constraints,
      writer: write.writer,
      gate: write.runValidators ? 'schema' : write.literalValues ? 'repository-check' : 'none',
      ref: write.runValidators ? RUN_VALIDATORS_REF : write.literalValues ? LITERAL_REF : '',
      note: write.literalValues ? `writes ${write.literalValues.map(v => JSON.stringify(v)).join(', ')}` : 'TODO',
    });

  it('finds writers at all - guards the scanner against silently matching nothing', () => {
    expect(scanned.length).toBeGreaterThan(100);
    expect(scanned.some(w => w.runValidators)).toBe(true);
  });

  it('lists every constrained path a literal update call writes, and nothing else', () => {
    const reported = new Set(report.map(rowKey));
    const found = new Set(scanned.map(rowKey));
    const missing = scanned.filter(w => !reported.has(rowKey(w))).map(suggestedRow);
    const stale = report.filter(r => !found.has(rowKey(r))).map(formatRow);

    expect(missing, 'writers missing from UNVALIDATED_UPDATE_PATHS.md - add these rows and set the gate').toEqual([]);
    expect(stale, 'rows in UNVALIDATED_UPDATE_PATHS.md that no longer match a writer - remove or rename').toEqual([]);
    expect(report.length, 'duplicate rows in UNVALIDATED_UPDATE_PATHS.md').toBe(reported.size);
  });

  it('records the constraint each path carries', () => {
    const byKey = new Map(scanned.map(w => [rowKey(w), w]));
    const drifted = report
      .filter(r => byKey.has(rowKey(r)) && byKey.get(rowKey(r))!.constraints.join() !== r.constraints.join())
      .map(r => `${rowKey(r)}: report ${r.constraints.join()} vs schema ${byKey.get(rowKey(r))!.constraints.join()}`);

    expect(drifted).toEqual([]);
  });

  it('keeps runValidators on every writer the report gates with it', () => {
    const byKey = new Map(scanned.map(w => [rowKey(w), w]));
    const lost = report
      .filter(r => r.ref === RUN_VALIDATORS_REF && byKey.get(rowKey(r))?.runValidators === false)
      .map(rowKey);
    const unreported = scanned
      .filter(w => w.runValidators)
      .filter(w => report.find(r => rowKey(r) === rowKey(w))?.ref !== RUN_VALIDATORS_REF)
      .map(rowKey);

    expect(lost, 'these writers dropped runValidators - restore it or re-gate the row').toEqual([]);
    expect(unreported, 'these writers now pass runValidators - mark the row schema / runValidators').toEqual([]);
  });

  it('stores only in-constraint literals on every literal-gated writer', () => {
    const byKey = new Map(scanned.map(w => [rowKey(w), w]));
    const problems: string[] = [];
    for (const row of report.filter(r => r.ref === LITERAL_REF)) {
      const write = byKey.get(rowKey(row));
      if (!write) continue;
      if (row.gate !== 'repository-check') problems.push(`${rowKey(row)}: a literal ref belongs to repository-check`);
      if (!write.literalValues) {
        problems.push(`${rowKey(row)}: now writes a runtime value - re-gate the row`);
        continue;
      }
      const schemaType = resolveSchemaType(mongoose.model(write.model).schema, write.path);
      if (!schemaType) throw new Error(`no schema path ${write.model}.${write.path}`);
      for (const value of write.literalValues) {
        const reason = violation(schemaType, value);
        if (reason) problems.push(`${rowKey(row)}: ${JSON.stringify(value)} ${reason}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('marks every runtime-valued writer with no runValidators by what actually gates it', () => {
    const byKey = new Map(scanned.map(w => [rowKey(w), w]));
    const problems: string[] = [];
    for (const row of report) {
      const write = byKey.get(rowKey(row));
      if (!write || write.runValidators || write.literalValues) continue;
      if (row.ref === RUN_VALIDATORS_REF || row.ref === LITERAL_REF) {
        problems.push(`${rowKey(row)}: ref ${row.ref} does not hold for this writer`);
      }
      if (row.gate !== 'none' && !/^[\w./[\]-]+\.ts#[\w.]+$/.test(row.ref)) {
        problems.push(`${rowKey(row)}: gate ${row.gate} needs a ref of the form path/file.ts#symbol`);
      }
      if (row.gate === 'none' && row.ref) problems.push(`${rowKey(row)}: gate none takes no ref`);
      if (!row.note) problems.push(`${rowKey(row)}: needs a note saying why`);
    }

    expect(problems).toEqual([]);
  });

  it('points every in-package ref at a symbol that still exists', () => {
    // Refs outside packages/database (route schemas in apps/client) are not read here: this suite's
    // turbo cache key covers this package only.
    const packageRoot = join(MODELS_ROOT, '../..');
    const missing: string[] = [];
    for (const row of report) {
      const match = /^(packages\/database\/[\w./-]+\.ts)#([\w.]+)$/.exec(row.ref);
      if (!match) continue;
      const file = join(packageRoot, '../..', match[1]!);
      const symbol = match[2]!.split('.').pop()!;
      if (!existsSync(file) || !readFileSync(file, 'utf8').includes(symbol)) missing.push(`${rowKey(row)}: ${row.ref}`);
    }

    expect(missing).toEqual([]);
  });
});

describe('unvalidated update paths inventory - hook gates', () => {
  setupMongoTest();

  it('still rejects an out-of-constraint value on every path a pre-update hook gates', async () => {
    const hookRows = parseReport(REPORT).filter(
      r => r.gate === 'schema' && r.ref !== RUN_VALIDATORS_REF && r.ref.startsWith('packages/database/')
    );
    expect(hookRows.length).toBeGreaterThan(0);

    const accepted: string[] = [];
    for (const row of hookRows) {
      const model = mongoose.model(row.model);
      const schemaType = resolveSchemaType(model.schema, row.path);
      if (!schemaType) throw new Error(`no schema path ${row.model}.${row.path}`);
      // No validators on this call: only the hook can refuse it.
      const result = await model
        .updateOne({ _id: new mongoose.Types.ObjectId() }, { $set: { [row.path]: invalidValueFor(schemaType) } })
        .then(
          () => 'accepted',
          (error: unknown) => (error instanceof mongoose.Error.ValidationError ? 'rejected' : String(error))
        );
      if (result !== 'rejected') accepted.push(`${rowKey(row)}: ${result}`);
    }

    expect(accepted).toEqual([]);
  });
});
