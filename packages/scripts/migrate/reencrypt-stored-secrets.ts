#!/usr/bin/env tsx

/**
 * Re-encrypts every stored at-rest ciphertext from SECRET_ENCRYPTION_KEY_PREVIOUS to
 * SECRET_ENCRYPTION_KEY, and verifies the result. The fields it walks are the SWEEP_FIELDS table
 * in ./reencrypt-stored-secrets-sweep.ts.
 *
 * Modes:
 *   (default)   For each stored ciphertext: skip it when the current key opens it, otherwise open
 *               it with the previous key and write it back under the current key. Safe to stop and
 *               run again: a finished value is skipped, so no progress marker is kept, and a second
 *               run rotates 0.
 *   --dry-run   Same walk, no writes. Reports what a run would rotate.
 *   --verify    Uses the current key alone and reports every value it does not open. Exit 0 here
 *               is the condition for clearing SECRET_ENCRYPTION_KEY_PREVIOUS.
 *
 * Output: one line of counts per collection.field and a total. No stored value and no document id
 * is printed. Exit code: 0 when every ciphertext is under the current key, 1 when any value is
 * unreadable or changed while it was being written (run again), 2 on a usage or connection error,
 * or when no ciphertext was found at all (wrong or empty database, unresolved %STAGE%).
 *
 * Writes go through the raw driver, are conditional on the exact value that was read, and set that
 * one path, so timestamps, hooks and neighbouring fields are untouched. A value bound to an owning
 * context is re-encrypted with the same context. Values that are not ciphertext are left alone;
 * the credential census (audit:credential-census) reports those.
 *
 * Config: SECRET_ENCRYPTION_KEY, SECRET_ENCRYPTION_KEY_PREVIOUS and MONGODB_URI from SST resources
 * (run under `sst shell`). Each falls back to the process env, which is how an install without
 * SST resources (self-host) supplies them.
 *
 * Usage:
 *   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --dry-run
 *   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets
 *   pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets --verify
 */

import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { isValidEncryptionKey } from '@bike4mind/utils/security';
import { getResource, getStage } from './encrypt-admin-settings-and-apikeys';
import { formatSweep, sweepExitCode, sweepStoredSecrets, type SweepMode } from './reencrypt-stored-secrets-sweep';

const usage = (): string =>
  `Re-encrypts stored secrets from SECRET_ENCRYPTION_KEY_PREVIOUS to SECRET_ENCRYPTION_KEY.

Usage: pnpm --filter @bike4mind/scripts migrate:reencrypt-stored-secrets [--dry-run | --verify] [--help]

  (no flag)   rotate every value still under the previous key
  --dry-run   report what a run would rotate, write nothing
  --verify    check every value with the current key alone

Exit codes: 0 everything is under the current key, 1 values unreadable or left for another run,
2 error or no ciphertext found.`;

const MODE_TITLE: Record<SweepMode, string> = {
  rewrite: 'ROTATE',
  'dry-run': 'DRY RUN (no writes)',
  verify: 'VERIFY (current key only)',
};

const validKey = (name: string): string | undefined => {
  const value = getResource(name) ?? process.env[name];
  return value && isValidEncryptionKey(value) ? value : undefined;
};

export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help')) {
    console.log(usage());
    return 0;
  }
  const unknown = argv.filter(arg => !['--dry-run', '--verify'].includes(arg));
  if (unknown.length > 0 || (argv.includes('--dry-run') && argv.includes('--verify'))) {
    console.error(usage());
    return 2;
  }
  const mode: SweepMode = argv.includes('--verify') ? 'verify' : argv.includes('--dry-run') ? 'dry-run' : 'rewrite';

  const currentKey = validKey('SECRET_ENCRYPTION_KEY');
  if (!currentKey) {
    console.error('SECRET_ENCRYPTION_KEY is not configured or is not 64 hex characters');
    return 2;
  }
  const previousKey = mode === 'verify' ? undefined : validKey('SECRET_ENCRYPTION_KEY_PREVIOUS');
  if (mode !== 'verify' && !previousKey) {
    console.error('SECRET_ENCRYPTION_KEY_PREVIOUS must hold the old key (64 hex characters) to rotate from it');
    return 2;
  }
  if (previousKey === currentKey) {
    console.error('SECRET_ENCRYPTION_KEY_PREVIOUS equals SECRET_ENCRYPTION_KEY: there is nothing to rotate');
    return 2;
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
    // Plain connect: no catalog seeding and no index builds. Short selection timeout so an
    // unreachable host fails fast.
    await mongoose.connect(template.replace('%STAGE%', stage), {
      autoIndex: false,
      autoCreate: false,
      serverSelectionTimeoutMS: 5000,
    });
    const db = mongoose.connection.db!;
    const rows = await sweepStoredSecrets(db, { currentKey, previousKey, mode });
    const code = sweepExitCode(rows);
    console.log(`Database: ${db.databaseName}\nMode: ${MODE_TITLE[mode]}\n${formatSweep(rows, mode)}`);
    if (code === 2) console.error('No ciphertext found in this database: wrong or empty database?');
    return code;
  } catch (error) {
    // Name and code only: a driver message can embed parts of the URI.
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : 'Error';
    console.error(
      `Re-encrypt failed (${name}${typeof code === 'string' || typeof code === 'number' ? `, ${code}` : ''})`
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
