#!/usr/bin/env tsx

/**
 * Read-only census of credential fields that are still plaintext (or unhashed, or not yet
 * context-bound) at rest. Use it to see which operator backfills an environment still needs, before
 * and after running them, and after restoring a backup.
 *
 * Output: one line per collection.field with `checked` (non-empty string values) and `plaintext`
 * (values not in the protected format) counts, plus `unbound` for provider keys and MCP env values
 * (ciphertext not yet in the context-bound `v2:` form). A row with pending values names the backfill
 * that converts it, or `no backfill`. Exit code: 0 when nothing is pending, 1 when any plaintext,
 * unhashed or unbound value remains, 2 on a usage or connection error.
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

Exit codes: 0 nothing pending, 1 values pending, 2 error.

Field -> backfill:
${formatFieldMap()}`;

async function run(): Promise<number> {
  if (process.argv.includes('--help')) {
    console.log(usage());
    return 0;
  }
  const uri = (getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '').replace('%STAGE%', getStage());
  if (!uri) throw new Error('MONGODB_URI is not configured (run under `sst shell` or set it in the environment)');
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  try {
    const rows = await runCredentialCensus(mongoose.connection.db!);
    console.log(formatCensus(rows));
    return censusExitCode(rows);
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(
    code => {
      process.exitCode = code;
    },
    (error: unknown) => {
      // Message only: a connection error can embed the URI.
      console.error(error instanceof Error ? error.message : 'Credential census failed');
      process.exitCode = 2;
    }
  );
}
