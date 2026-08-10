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
 *
 * Usage:
 *   pnpm --filter scripts migrate:encrypt-admin-secrets -- --dry-run
 *   pnpm --filter scripts migrate:encrypt-admin-secrets
 *   pnpm --filter scripts migrate:encrypt-admin-secrets -- --reencrypt
 */

import { connectDB } from '@bike4mind/database';
import { settingsMap, SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { decryptSecret, encryptSecret, isEncrypted, isValidEncryptionKey } from '@bike4mind/utils/security';
import { Resource } from 'sst';
import mongoose from 'mongoose';

const DRY_RUN = process.argv.includes('--dry-run');
const REENCRYPT = process.argv.includes('--reencrypt');

interface MigrationStats {
  collection: string;
  scanned: number;
  encrypted: number;
  skipped: number;
  errors: number;
}

function getResource(name: string): string | undefined {
  return (Resource as unknown as Record<string, { value?: string }>)[name]?.value;
}

/** Setting keys tagged isSensitive - the only adminsettings values we encrypt. */
const SENSITIVE_SETTING_KEYS = new Set(
  Object.entries(settingsMap)
    .filter(([, def]) => (def as { isSensitive?: boolean })?.isSensitive === true)
    .map(([key]) => key)
);

/**
 * Normal mode: encrypt plaintext, skip already-encrypted (returns null).
 * Reencrypt mode: decrypt with the old key and re-encrypt with the new key.
 * Returns null when there is nothing to do, or 'error' when a value cannot be recovered.
 */
function encryptIfNeeded(value: unknown, newKey: string, oldKey?: string): string | null | 'error' {
  if (typeof value !== 'string' || value.length === 0) return null;
  // A masked display value is never a real secret - never persist it.
  if (value.startsWith(SENSITIVE_SETTING_MASK)) return null;

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
    const next = encryptIfNeeded(doc.settingValue, key, oldKey);
    if (next === 'error') {
      console.error(`  ERROR AdminSetting ${doc.settingName}: failed to decrypt`);
      stats.errors++;
      continue;
    }
    if (!next) {
      stats.skipped++;
      continue;
    }
    console.log(`  AdminSetting ${doc.settingName}: ${REENCRYPT ? 're-encrypting' : 'encrypting'}`);
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
    const next = encryptIfNeeded(doc.apiKey, key, oldKey);
    if (next === 'error') {
      console.error(`  ERROR ApiKey ${doc._id}: failed to decrypt`);
      stats.errors++;
      continue;
    }
    if (!next) {
      stats.skipped++;
      continue;
    }
    console.log(`  ApiKey ${doc._id} (${doc.type}): ${REENCRYPT ? 're-encrypting' : 'encrypting'}`);
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
  const encryptionKey = getResource('SECRET_ENCRYPTION_KEY');
  if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
    console.error('SECRET_ENCRYPTION_KEY is not configured or is not 64 hex characters');
    process.exit(1);
  }

  let previousKey: string | undefined;
  if (REENCRYPT) {
    previousKey = getResource('SECRET_ENCRYPTION_KEY_PREVIOUS');
    if (!previousKey || !isValidEncryptionKey(previousKey) || previousKey === 'not-configured') {
      console.error('--reencrypt requires SECRET_ENCRYPTION_KEY_PREVIOUS to be set to the old key');
      process.exit(1);
    }
  }

  const mongoURI = (getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '').replace('%STAGE%', Resource.App.stage);

  console.log('\n=== Admin Settings + API Key Encryption Migration ===');
  console.log(`Stage: ${Resource.App.stage}`);
  const action = REENCRYPT ? 'RE-ENCRYPT (key rotation)' : 'ENCRYPT';
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
      `  ${stats.collection}: ${stats.encrypted} encrypted, ${stats.skipped} skipped, ${stats.errors} errors (${stats.scanned} scanned)`
    );
  }

  const totalEncrypted = allStats.reduce((sum, s) => sum + s.encrypted, 0);
  const totalErrors = allStats.reduce((sum, s) => sum + s.errors, 0);
  console.log(`\n  Total: ${totalEncrypted} fields encrypted, ${totalErrors} errors`);
  if (DRY_RUN) console.log('  (DRY RUN - no changes written)\n');

  process.exit(totalErrors > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
