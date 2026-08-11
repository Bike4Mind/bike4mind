#!/usr/bin/env tsx

/**
 * Migration: Encrypt Admin Settings + Per-User API Keys at Rest
 *
 * Encrypts plaintext secrets stored in MongoDB using AES-256-GCM, matching the
 * decrypt-on-read the repositories now perform:
 *   - adminsettings: settingValue of every `isSensitive` setting (settingsMap)
 *   - apikeys: the per-user provider `apiKey` field
 *
 * Safety:
 *   - Uses isEncrypted() to skip already-encrypted values (idempotent, re-runnable)
 *   - Skips masked placeholders (values starting with the sensitive-setting mask), which
 *     are display artifacts, never real secrets
 *   - Only touches string values (sreAgentConfig is an object and manages its own
 *     per-repo secrets; it is not isSensitive and is skipped here)
 *   - Atomic per-document updates
 *   - --dry-run mode makes no writes
 *   - --reencrypt rotates values from SECRET_ENCRYPTION_KEY_PREVIOUS to SECRET_ENCRYPTION_KEY
 *   - --decrypt reverses this migration (ciphertext -> plaintext), the inverse used to roll
 *     back past it (see below). Mutually exclusive with --reencrypt.
 *
 * Rollback / deploy order:
 *   This migration is NOT self-reversing. Old code that predates decrypt-on-read reads the
 *   iv:authTag:ciphertext blob as a live credential, so rolling the app back past this change
 *   while the data is encrypted breaks Slack signature checks, demo-key inference, OAuth, etc.
 *   The ciphertext is not destroyed (recovery is roll-forward, not a DB restore), but if you
 *   must run older code against this data, run `--decrypt` first to return the rows to plaintext.
 *
 * Coverage (rotation caveat): --reencrypt / --decrypt only touch `adminsettings` and
 *   `apikeys`. Other at-rest ciphertext stores - UserModel accessToken/refreshToken,
 *   OverwatchSocialConnectionModel, SRE per-repo secrets - are NOT covered here, so
 *   SECRET_ENCRYPTION_KEY_PREVIOUS must remain configured after any rotation; dropping it
 *   silently blanks those uncovered stores on read.
 *
 * Config is read from SST resources (run under `sst shell`); MONGODB_URI falls back to the
 * process env when not linked.
 *
 * Usage:
 *   pnpm --filter scripts migrate:encrypt-admin-secrets -- --dry-run
 *   pnpm --filter scripts migrate:encrypt-admin-secrets
 *   pnpm --filter scripts migrate:encrypt-admin-secrets -- --reencrypt
 *   pnpm --filter scripts migrate:encrypt-admin-secrets -- --decrypt
 */

import { connectDB } from '@bike4mind/database';
import { settingsMap, SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { decryptSecret, encryptSecret, isEncrypted, isValidEncryptionKey } from '@bike4mind/utils/security';
import { Resource } from 'sst';
import mongoose from 'mongoose';

const DRY_RUN = process.argv.includes('--dry-run');
const REENCRYPT = process.argv.includes('--reencrypt');
const DECRYPT = process.argv.includes('--decrypt');

interface MigrationStats {
  collection: string;
  scanned: number;
  encrypted: number;
  skipped: number;
  errors: number;
}

// Gerund + past tense used in the per-document progress logs and the summary.
const ACTION_VERB = DECRYPT ? 'decrypting' : REENCRYPT ? 're-encrypting' : 'encrypting';
const ACTION_PAST = DECRYPT ? 'decrypted' : REENCRYPT ? 're-encrypted' : 'encrypted';

// Guarded read: an unlinked/unprovisioned SST secret throws in the getter itself, so a bare
// `Resource[name]?.value` never falls through to a `?? process.env` arm. Matches the reader in
// packages/database/src/priceCatalogBootstrap.ts.
function getResource(name: string): string | undefined {
  try {
    return (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
  } catch {
    return undefined;
  }
}

// Resource.App also throws when the script runs outside `sst shell`; fall back to the seed env.
function getStage(): string {
  try {
    return Resource.App.stage;
  } catch {
    return process.env.SEED_STAGE_NAME ?? process.env.STAGE ?? '';
  }
}

/** Setting keys tagged isSensitive - the only adminsettings values we encrypt. */
const SENSITIVE_SETTING_KEYS = new Set(
  Object.entries(settingsMap)
    .filter(([, def]) => (def as { isSensitive?: boolean })?.isSensitive === true)
    .map(([key]) => key)
);

/**
 * Compute the new stored value for one field, or null when there is nothing to do.
 * - Normal mode: encrypt plaintext; already-encrypted -> null (skip).
 * - --reencrypt: decrypt with the old key and re-encrypt with the new; already-new -> null.
 * - --decrypt: ciphertext -> plaintext (the inverse, for rolling back past this migration);
 *   already-plaintext -> null.
 * Returns 'error' when a ciphertext value cannot be recovered with the available key(s).
 */
function transformIfNeeded(value: unknown, newKey: string, oldKey?: string): string | null | 'error' {
  if (typeof value !== 'string' || value.length === 0) return null;
  // A masked display value is never a real secret - never persist it.
  if (value.startsWith(SENSITIVE_SETTING_MASK)) return null;

  if (DECRYPT) {
    if (!isEncrypted(value)) return null; // already plaintext
    for (const key of [newKey, oldKey]) {
      if (!key) continue;
      try {
        return decryptSecret(value, key);
      } catch {
        /* try the next key (rotation) before giving up */
      }
    }
    console.error('    ERROR: value could not be decrypted with either key');
    return 'error';
  }

  if (REENCRYPT && oldKey) {
    if (!isEncrypted(value)) return null;
    try {
      decryptSecret(value, newKey);
      return null; // already under the new key
    } catch {
      /* not the new key - fall through to rotate */
    }
    try {
      return encryptSecret(decryptSecret(value, oldKey), newKey);
    } catch (err) {
      console.error(
        '    ERROR: value could not be decrypted with either key:',
        err instanceof Error ? err.message : err
      );
      return 'error';
    }
  }

  if (isEncrypted(value)) return null; // already encrypted
  return encryptSecret(value, newKey);
}

async function migrateAdminSettings(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'adminsettings', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('adminsettings');

  const cursor = collection.find({ settingName: { $in: Array.from(SENSITIVE_SETTING_KEYS) } });
  for await (const doc of cursor) {
    stats.scanned++;
    const next = transformIfNeeded(doc.settingValue, key, oldKey);
    if (next === 'error') {
      console.error(`  ERROR AdminSetting ${doc.settingName}: failed to decrypt`);
      stats.errors++;
      continue;
    }
    if (next === null) {
      stats.skipped++;
      continue;
    }
    console.log(`  AdminSetting ${doc.settingName}: ${ACTION_VERB}`);
    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { settingValue: next } });
        stats.encrypted++;
      } catch (err) {
        console.error(`  ERROR AdminSetting ${doc.settingName}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted++;
    }
  }
  return stats;
}

async function migrateApiKeys(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'apikeys', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('apikeys');

  const cursor = collection.find({ apiKey: { $exists: true, $ne: '' } });
  for await (const doc of cursor) {
    stats.scanned++;
    const next = transformIfNeeded(doc.apiKey, key, oldKey);
    if (next === 'error') {
      console.error(`  ERROR ApiKey ${doc._id}: failed to decrypt`);
      stats.errors++;
      continue;
    }
    if (next === null) {
      stats.skipped++;
      continue;
    }
    console.log(`  ApiKey ${doc._id} (${doc.type}): ${ACTION_VERB}`);
    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { apiKey: next } });
        stats.encrypted++;
      } catch (err) {
        console.error(`  ERROR ApiKey ${doc._id}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted++;
    }
  }
  return stats;
}

async function run() {
  if (REENCRYPT && DECRYPT) {
    console.error('Pass at most one of --reencrypt or --decrypt');
    process.exit(1);
  }

  const encryptionKey = getResource('SECRET_ENCRYPTION_KEY');
  if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
    console.error('SECRET_ENCRYPTION_KEY is not configured or is not 64 hex characters');
    process.exit(1);
  }

  // Load the previous key best-effort: --reencrypt requires it (to decrypt old ciphertext),
  // --decrypt uses it as a second decrypt candidate when a value is still under the old key.
  let previousKey = getResource('SECRET_ENCRYPTION_KEY_PREVIOUS');
  if (previousKey && (!isValidEncryptionKey(previousKey) || previousKey === 'not-configured')) {
    previousKey = undefined;
  }
  if (REENCRYPT && !previousKey) {
    console.error('--reencrypt requires SECRET_ENCRYPTION_KEY_PREVIOUS to be set to the old key');
    process.exit(1);
  }

  const stage = getStage();
  const mongoURI = (getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '').replace('%STAGE%', stage);

  console.log('\n=== Admin Settings + API Key Encryption Migration ===');
  console.log(`Stage: ${stage}`);
  const action = DECRYPT ? 'DECRYPT (rollback to plaintext)' : REENCRYPT ? 'RE-ENCRYPT (key rotation)' : 'ENCRYPT';
  const mode = DRY_RUN ? `DRY RUN - ${action} (no changes)` : `LIVE - ${action}`;
  console.log(`Mode: ${mode}\n`);

  await connectDB(mongoURI);
  const db = mongoose.connection.db!;

  const allStats: MigrationStats[] = [];
  allStats.push(await migrateAdminSettings(db, encryptionKey, previousKey));
  allStats.push(await migrateApiKeys(db, encryptionKey, previousKey));

  console.log('\n=== Migration Summary ===');
  for (const stats of allStats) {
    console.log(
      `  ${stats.collection}: ${stats.encrypted} ${ACTION_PAST}, ${stats.skipped} skipped, ${stats.errors} errors (${stats.scanned} scanned)`
    );
  }

  const totalEncrypted = allStats.reduce((sum, s) => sum + s.encrypted, 0);
  const totalErrors = allStats.reduce((sum, s) => sum + s.errors, 0);
  console.log(`\n  Total: ${totalEncrypted} fields ${ACTION_PAST}, ${totalErrors} errors`);
  if (DRY_RUN) console.log('  (DRY RUN - no changes written)\n');

  process.exit(totalErrors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
