#!/usr/bin/env tsx

/**
 * Moves every stored memory data key from MEMORY_KEY_SECRET_PREVIOUS to MEMORY_KEY_SECRET, and
 * verifies the result. Data keys are re-wrapped only: the keys that encrypt the facts do not change.
 *
 * Modes:
 *   (default)   For each wrapped key: skip it when the current key opens it, otherwise open it with
 *               the previous key and write it back under the current key. A second run rewraps 0.
 *   --dry-run   Same walk, no writes.
 *   --verify    Uses the current key alone, reports every key it does not open, and decrypts one
 *               stored fact from the current key incarnation per principal. Exit 0 here is the condition for clearing
 *               MEMORY_KEY_SECRET_PREVIOUS.
 *
 * Output: counts only. No key row id and no stored value is printed. Exit code: 0 when every key is
 * under the current key, 1 when any key is unreadable or changed while it was written (run again),
 * 2 on a usage or connection error, when an environment secret differs from the linked SST resource,
 * or when keys are stored unwrapped (run migrate:protect-credentials first). A preflight raw-key census stops before writes; a raw key
 * discovered later reports partial progress. Destroyed principals are skipped.
 *
 * Writes go through the raw driver and are conditional on the exact value that was read.
 *
 * Config: memory keys use the runtime's process-env-first order, then SST resources; a process-env
 * secret that differs from a linked SST resource is refused rather than overriding it. MONGODB_URI
 * comes from SST resources (`sst shell`), falling back to process env (self-host). Procedure:
 * docs/security/credential-storage.md.
 *
 * Usage:
 *   pnpm --filter @bike4mind/scripts migrate:rewrap-memory-keys --dry-run
 *   pnpm --filter @bike4mind/scripts migrate:rewrap-memory-keys
 *   pnpm --filter @bike4mind/scripts migrate:rewrap-memory-keys --verify
 */

import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { resolveMasterKey, resolvePreviousMasterKey } from '@bike4mind/server-utils/memory/factCipher';
import { getResource, getStage } from './encrypt-admin-settings-and-apikeys';
import { formatSweep, sweepExitCode, sweepMemoryKeys, type SweepMode } from './rewrap-memory-keys-sweep';

const usage = (): string =>
  `Moves stored memory data keys from MEMORY_KEY_SECRET_PREVIOUS to MEMORY_KEY_SECRET.

Usage: pnpm --filter @bike4mind/scripts migrate:rewrap-memory-keys [--dry-run | --verify] [--help]

  (no flag)   rewrap every key still under the previous key
  --dry-run   report what a run would rewrap, write nothing
  --verify    check every key and one fact per principal with the current key alone

Exit codes: 0 everything is under the current key, 1 keys unreadable or left for another run,
2 error, an environment secret that differs from the SST resource, or keys stored unwrapped.`;

const MODE_TITLE: Record<SweepMode, string> = {
  rewrite: 'REWRAP',
  'dry-run': 'DRY RUN (no writes)',
  verify: 'VERIFY (current key only)',
};

const secret = (name: string): string | undefined => process.env[name] || getResource(name);

const configured = (value: string | undefined): string | undefined =>
  value && value !== 'not-configured' ? value : undefined;

const envDiffersFromResource = (name: string, derive: (secret: string) => Buffer | undefined): boolean => {
  const fromEnv = configured(process.env[name]);
  const fromResource = configured(getResource(name));
  if (!fromEnv || !fromResource) return false;
  const envKey = derive(fromEnv);
  const resourceKey = derive(fromResource);
  return !!envKey && !!resourceKey && !envKey.equals(resourceKey);
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

  const conflicts = [
    envDiffersFromResource('MEMORY_KEY_SECRET', resolveMasterKey) && 'MEMORY_KEY_SECRET',
    mode !== 'verify' &&
      envDiffersFromResource('MEMORY_KEY_SECRET_PREVIOUS', resolvePreviousMasterKey) &&
      'MEMORY_KEY_SECRET_PREVIOUS',
  ].filter((name): name is string => !!name);
  if (conflicts.length > 0) {
    for (const name of conflicts) {
      console.error(
        `${name} in the environment differs from the linked SST resource; unset the environment variable or run outside sst shell`
      );
    }
    return 2;
  }

  const current = resolveMasterKey(secret('MEMORY_KEY_SECRET') ?? '');
  if (!current) {
    console.error('MEMORY_KEY_SECRET is not configured');
    return 2;
  }
  const previous = mode === 'verify' ? undefined : resolvePreviousMasterKey(secret('MEMORY_KEY_SECRET_PREVIOUS') ?? '');
  if (mode !== 'verify' && !previous) {
    console.error('MEMORY_KEY_SECRET_PREVIOUS must hold the old secret to rewrap from it');
    return 2;
  }
  if (previous?.equals(current)) {
    console.error('MEMORY_KEY_SECRET_PREVIOUS equals MEMORY_KEY_SECRET: there is nothing to rewrap');
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
    const counts = await sweepMemoryKeys(db, { current, previous }, mode);
    console.log(`Database: ${db.databaseName}\nMode: ${MODE_TITLE[mode]}\n${formatSweep(counts, mode)}`);
    return sweepExitCode(counts);
  } catch (error) {
    // Name and code only: a driver message can embed parts of the URI.
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : 'Error';
    console.error(`Rewrap failed (${name}${typeof code === 'string' || typeof code === 'number' ? `, ${code}` : ''})`);
    return 2;
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(code => {
    process.exitCode = code;
  });
}
