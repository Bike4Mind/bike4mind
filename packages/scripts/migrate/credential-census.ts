#!/usr/bin/env tsx

/**
 * Read-only census of credential fields that are still plaintext (or unhashed, or not yet
 * context-bound) at rest. Use it to see which operator backfills an environment still needs, before
 * and after running them, and after restoring a backup.
 *
 * Output: one line per collection.field with `checked` (non-empty string values) and `plaintext`
 * (values not in the protected format) counts, plus `unbound` for provider keys and MCP env values
 * (ciphertext not yet in the context-bound `v2:` form). A row with pending values names the backfill
 * that converts it, or `no backfill`. The first line names the database read. Exit code: 0 when
 * nothing is pending, 1 when any plaintext, unhashed or unbound value remains, 2 on a usage or
 * connection error, or when every field is empty (wrong or empty database, unresolved %STAGE%).
 *
 * Safety: counting runs inside the database and only counts are returned, so no stored value or
 * document id reaches this process or its output. The script connects with plain mongoose (no
 * catalog seeding, no index builds), issues only read aggregations, and needs no encryption key.
 *
 * Config: MONGODB_URI from SST resources (run under `sst shell`), falling back to the process env.
 *
 * Usage:
 *   pnpm --filter @bike4mind/scripts audit:credential-census
 *   pnpm --filter @bike4mind/scripts audit:credential-census --help
 *
 * Field -> backfill map: see `--help` (generated from the same table the census runs).
 */

import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { getResource, getStage } from './encrypt-admin-settings-and-apikeys';
import { censusExitCode, formatCensus, formatFieldMap, runCredentialCensus } from './credential-census-report';

const usage = (): string =>
  `Read-only census of plaintext, unhashed or unbound credential fields.

Usage: pnpm --filter @bike4mind/scripts audit:credential-census [--help]

Exit codes: 0 nothing pending, 1 values pending, 2 error or no credential values found.

Field -> backfill:
${formatFieldMap()}`;

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help')) {
    console.log(usage());
    return 0;
  }
  const template = getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '';
  if (!template) {
    console.error('MONGODB_URI is not configured (run under `sst shell` or set it in the environment)');
    return 2;
  }
  const stage = getStage();
  if (template.includes('%STAGE%') && !stage) {
    console.error('The database URI needs a stage but none is set (run under `sst shell` or set STAGE)');
    return 2;
  }
  try {
    // Short selection timeout so an unreachable host fails fast.
    await mongoose.connect(template.replace('%STAGE%', stage), {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5000,
    });
    const db = mongoose.connection.db!;
    const rows = await runCredentialCensus(db);
    const code = censusExitCode(rows);
    console.log(`Database: ${db.databaseName}\n${formatCensus(rows)}`);
    if (code === 2) console.error('No credential values found in this database: wrong or empty database?');
    return code;
  } catch (error) {
    // Name and code only: a driver message can embed parts of the URI.
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : 'Error';
    console.error(
      `Credential census failed (${name}${typeof code === 'string' || typeof code === 'number' ? `, ${code}` : ''})`
    );
    return 2;
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(code => {
    process.exitCode = code;
  });
}
