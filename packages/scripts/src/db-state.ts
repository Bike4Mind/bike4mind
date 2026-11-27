#!/usr/bin/env tsx

/**
 * Records a database's structural state to a JSON file (`snapshot`) and diffs two such files
 * (`compare`). Meant to run before and after database maintenance or a large migration.
 *
 * Safety: the snapshot connects with autoIndex and autoCreate off, registers no model on its
 * connection, and sends only the read commands listed in dbState/readOnlyGuard.ts. Every command
 * is checked as it is sent; one outside that list fails the run with exit code 3. The connection
 * string is never printed.
 *
 * Config: MONGODB_URI from SST resources (run under `sst shell`), falling back to the process env.
 * See the "Database state snapshot" section of packages/scripts/README.md for every flag.
 *
 * Exit codes: snapshot 0 ok, 2 error, 3 a non-read command was sent; compare 0 no differences,
 * 1 differences outside the tolerance, 2 error.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { getResource, getStage } from '../migrate/encrypt-admin-settings-and-apikeys';
import { stringifySnapshot } from './dbState/canonicalJson';
import { compareSnapshots, formatComparison } from './dbState/compareSnapshots';
import { describeError } from './dbState/describeError';
import { recordCommands } from './dbState/readOnlyGuard';
import { collectDeclaredIndexes, type DeclaredIndex } from './dbState/schemaDrift';
import { SnapshotSchema, UNDEFINED_SCAN_MODES, type Snapshot, type UndefinedScanMode } from './dbState/snapshotSchema';
import { takeSnapshot } from './dbState/takeSnapshot';

type SnapshotArgs = {
  out: string;
  exactCounts: boolean;
  schemaCheck: boolean;
  undefinedScan: UndefinedScanMode;
  scanTimeLimitMs: number;
};

type CompareArgs = {
  before: string;
  after: string;
  countTolerance: number;
  countTolerancePercent: number;
};

const resolveUri = (): string | null => {
  const template = getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '';
  if (!template) return null;
  if (!template.includes('%STAGE%')) return template;
  const stage = getStage();
  return stage ? template.replace('%STAGE%', stage) : null;
};

/** Loading the models only reads their schemas: they live on the default connection, which never opens here. */
const loadDeclaredIndexes = async (): Promise<DeclaredIndex[]> => {
  const { mongoose: databaseMongoose } = await import('@bike4mind/database');
  databaseMongoose.set('autoIndex', false);
  databaseMongoose.set('autoCreate', false);
  return collectDeclaredIndexes(Object.values(databaseMongoose.models));
};

export const runSnapshot = async (args: SnapshotArgs, uri: string | null = resolveUri()): Promise<number> => {
  if (!uri) {
    console.error(
      'MONGODB_URI is not configured (run under `sst shell`, or set MONGODB_URI and STAGE if it needs one)'
    );
    return 2;
  }
  const declaredIndexes = args.schemaCheck ? await loadDeclaredIndexes() : null;
  const connection = mongoose.createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
    monitorCommands: true,
    serverSelectionTimeoutMS: 10_000,
  });
  try {
    await connection.asPromise();
    const recorder = recordCommands(connection.getClient());
    const snapshot = await takeSnapshot(connection.db!, {
      exactCounts: args.exactCounts,
      declaredIndexes,
      undefinedScan: args.undefinedScan,
      scanTimeLimitMs: args.scanTimeLimitMs,
    });
    recorder.stop();
    if (recorder.violations.length > 0) {
      console.error(`Refusing to write the snapshot: non-read commands were sent: ${recorder.violations.join(', ')}`);
      return 3;
    }
    await writeFile(args.out, stringifySnapshot(snapshot), { mode: 0o600 });
    console.log(
      `Wrote ${args.out}: ${snapshot.collections.length} collections in ${snapshot.database} (server ${snapshot.server.version})`
    );
    return 0;
  } catch (error) {
    console.error(`Snapshot failed (${describeError(error)})`);
    return 2;
  } finally {
    await connection.close();
  }
};

const readSnapshot = async (path: string): Promise<Snapshot> =>
  SnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));

export const runCompare = async (args: CompareArgs): Promise<number> => {
  try {
    const before = await readSnapshot(args.before);
    const after = await readSnapshot(args.after);
    const comparison = compareSnapshots(before, after, {
      absolute: args.countTolerance,
      percent: args.countTolerancePercent,
    });
    console.log(formatComparison(before, after, comparison));
    return comparison.differences.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Compare failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
};

export const run = async (argv: string[] = hideBin(process.argv)): Promise<number> => {
  let exitCode = 0;
  await yargs(argv)
    .scriptName('db:state')
    .command(
      'snapshot',
      'Write a JSON file describing the database (read-only)',
      builder =>
        builder
          .option('out', { type: 'string', demandOption: true, describe: 'File to write the snapshot to' })
          .option('exact-counts', { type: 'boolean', default: false, describe: 'Also count every document (slow)' })
          .option('schema-check', {
            type: 'boolean',
            default: true,
            describe: 'Compare indexes declared in the Mongoose schemas with the database (--no-schema-check skips)',
          })
          .option('undefined-scan', {
            choices: UNDEFINED_SCAN_MODES,
            default: 'off' as UndefinedScanMode,
            describe: 'Count documents holding a BSON undefined value, read from a secondary',
          })
          .option('scan-time-limit-ms', {
            type: 'number',
            default: 60_000,
            describe: 'Time limit per collection for the undefined scan',
          }),
      async parsed => {
        exitCode = await runSnapshot(parsed);
      }
    )
    .command(
      'compare <before> <after>',
      'Diff two snapshot files; exits 1 when they differ',
      builder =>
        builder
          .positional('before', { type: 'string', demandOption: true })
          .positional('after', { type: 'string', demandOption: true })
          .option('count-tolerance', {
            type: 'number',
            default: 0,
            describe: 'Ignore document count changes up to this many documents',
          })
          .option('count-tolerance-percent', {
            type: 'number',
            default: 0,
            describe: 'Ignore document count changes up to this percentage of the before count',
          }),
      async parsed => {
        exitCode = await runCompare(parsed);
      }
    )
    .demandCommand(1)
    .strict()
    .parseAsync();
  return exitCode;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(code => {
    process.exit(code);
  });
}
