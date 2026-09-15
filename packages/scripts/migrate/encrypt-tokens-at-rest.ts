#!/usr/bin/env tsx

/**
 * Migration: Encrypt Existing Tokens at Rest
 *
 * Encrypts all plaintext OAuth tokens, API keys, and webhook secrets
 * stored in MongoDB using AES-256-GCM.
 *
 * Affected collections:
 *   - users: atlassianConnect tokens, googleDrive tokens, slackUserToken, blogIntegration apiKey
 *   - mcpservers: envVariables values, webhook secrets
 *   - orgslackworkspaces: slackBotToken
 *   - slackdevworkspaces: slackBotToken
 *
 * Safety:
 *   - Uses isEncrypted() guard to skip already-encrypted values
 *   - Processes documents one at a time with atomic updates
 *   - Supports --dry-run mode
 *   - Logs all changes for audit trail
 *
 * Usage:
 *   pnpm --filter scripts migrate:encrypt-tokens -- --dry-run
 *   pnpm --filter scripts migrate:encrypt-tokens
 *   pnpm --filter scripts migrate:encrypt-tokens -- --reencrypt
 */

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import mongoose from 'mongoose';
import crypto from 'crypto';

// Inline encryption utilities (can't import from @server).
// IMPORTANT: Must stay in sync with apps/client/server/utils/secretEncryption.ts

const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

function encryptSecret(plaintext: string, key: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'hex'), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptSecret(encrypted: string, key: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted format');
  const [ivHex, authTagHex, encryptedData] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function isEncrypted(value: string): boolean {
  if (!value) return false;
  return /^[a-f0-9]{32}:[a-f0-9]{32}:[a-f0-9]+$/i.test(value);
}

// Main

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

async function run() {
  const encryptionKey = getResource('SECRET_ENCRYPTION_KEY');
  if (!encryptionKey || encryptionKey.length !== KEY_LENGTH * 2) {
    console.error('SECRET_ENCRYPTION_KEY is not configured or invalid length');
    process.exit(1);
  }

  let previousKey: string | undefined;
  if (REENCRYPT) {
    previousKey = getResource('SECRET_ENCRYPTION_KEY_PREVIOUS');
    if (!previousKey || previousKey.length !== KEY_LENGTH * 2 || previousKey === 'not-configured') {
      console.error('--reencrypt requires SECRET_ENCRYPTION_KEY_PREVIOUS to be set to the old key');
      process.exit(1);
    }
  }

  const mongoURI = (getResource('MONGODB_URI') ?? process.env.MONGODB_URI ?? '').replace('%STAGE%', Resource.App.stage);

  console.log(`\n=== Token Encryption Migration ===`);
  console.log(`Stage: ${Resource.App.stage}`);
  let mode = 'LIVE';
  if (DRY_RUN) mode = 'DRY RUN (no changes)';
  else if (REENCRYPT) mode = 'RE-ENCRYPT (key rotation)';
  console.log(`Mode: ${mode}\n`);

  await connectDB(mongoURI);
  const db = mongoose.connection.db!;

  const allStats: MigrationStats[] = [];

  // 1. Users collection
  allStats.push(await migrateUsers(db, encryptionKey, previousKey));

  // 2. MCP Servers collection
  allStats.push(await migrateMcpServers(db, encryptionKey, previousKey));

  // 3. Org Slack Workspaces collection
  allStats.push(await migrateOrgSlackWorkspaces(db, encryptionKey, previousKey));

  // 4. Slack Dev Workspaces collection
  allStats.push(await migrateSlackDevWorkspaces(db, encryptionKey, previousKey));

  // Summary
  console.log('\n=== Migration Summary ===');
  for (const stats of allStats) {
    console.log(
      `  ${stats.collection}: ${stats.encrypted} encrypted, ${stats.skipped} skipped, ${stats.errors} errors (${stats.scanned} scanned)`
    );
  }

  const totalEncrypted = allStats.reduce((sum, s) => sum + s.encrypted, 0);
  const totalErrors = allStats.reduce((sum, s) => sum + s.errors, 0);
  console.log(`\n  Total: ${totalEncrypted} fields encrypted, ${totalErrors} errors`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes written)\n');

  process.exit(totalErrors > 0 ? 1 : 0);
}

/**
 * For normal mode: encrypts plaintext values, skips already-encrypted.
 * For --reencrypt mode: decrypts with previous key, re-encrypts with new key.
 * Returns 'error' if the value could not be decrypted with either key.
 */
function reencryptValue(value: string, newKey: string, oldKey: string): string | null | 'error' {
  if (!isEncrypted(value)) return null; // plaintext, not our concern in reencrypt mode

  // Already encrypted with the new key; nothing to do
  try {
    decryptSecret(value, newKey);
    return null;
  } catch {
    /* not the new key */
  }

  // Decrypt with old key and re-encrypt with new key
  try {
    const plaintext = decryptSecret(value, oldKey);
    return encryptSecret(plaintext, newKey);
  } catch (err) {
    console.error(`    ERROR: value could not be decrypted with either key:`, err instanceof Error ? err.message : err);
    return 'error';
  }
}

function encryptIfNeeded(value: string | undefined | null, newKey: string, oldKey?: string): string | null | 'error' {
  if (!value) return null;
  if (REENCRYPT && oldKey) return reencryptValue(value, newKey, oldKey);
  if (isEncrypted(value)) return null; // already encrypted
  return encryptSecret(value, newKey);
}

async function migrateUsers(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'users', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('users');

  // Find users that have any token fields
  const cursor = collection.find({
    $or: [
      { 'atlassianConnect.accessToken': { $exists: true, $ne: '' } },
      { 'atlassianConnect.refreshToken': { $exists: true, $ne: '' } },
      { 'googleDrive.accessToken': { $exists: true, $ne: '' } },
      { 'googleDrive.refreshToken': { $exists: true, $ne: '' } },
      { 'slackSettings.slackUserToken': { $exists: true, $ne: '' } },
      { 'blogIntegration.apiKey': { $exists: true, $ne: '' } },
    ],
  });

  for await (const doc of cursor) {
    stats.scanned++;
    const updates: Record<string, string> = {};

    const fields = [
      { path: 'atlassianConnect.accessToken', value: doc.atlassianConnect?.accessToken },
      { path: 'atlassianConnect.refreshToken', value: doc.atlassianConnect?.refreshToken },
      { path: 'googleDrive.accessToken', value: doc.googleDrive?.accessToken },
      { path: 'googleDrive.refreshToken', value: doc.googleDrive?.refreshToken },
      { path: 'slackSettings.slackUserToken', value: doc.slackSettings?.slackUserToken },
      { path: 'blogIntegration.apiKey', value: doc.blogIntegration?.apiKey },
    ];

    for (const field of fields) {
      const encrypted = encryptIfNeeded(field.value, key, oldKey);
      if (encrypted === 'error') {
        console.error(`  ERROR User ${doc._id}: failed to decrypt ${field.path}`);
        stats.errors++;
      } else if (encrypted) {
        updates[field.path] = encrypted;
      }
    }

    if (Object.keys(updates).length === 0) {
      stats.skipped++;
      continue;
    }

    const action = REENCRYPT ? 're-encrypting' : 'encrypting';
    console.log(`  User ${doc._id}: ${action} ${Object.keys(updates).join(', ')}`);

    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: updates });
        stats.encrypted += Object.keys(updates).length;
      } catch (err) {
        console.error(`  ERROR User ${doc._id}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted += Object.keys(updates).length;
    }
  }

  console.log(`Users: ${stats.encrypted} fields encrypted, ${stats.skipped} skipped`);
  return stats;
}

async function migrateMcpServers(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'mcpservers', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('mcpservers');

  const cursor = collection.find({
    $or: [{ 'envVariables.0': { $exists: true } }, { 'metadata.webhooks.github.secret': { $exists: true, $ne: '' } }],
  });

  for await (const doc of cursor) {
    stats.scanned++;
    const updates: Record<string, unknown> = {};

    // Encrypt envVariables values
    if (Array.isArray(doc.envVariables) && doc.envVariables.length > 0) {
      let anyChanged = false;
      let envError = false;
      const newEnvVars = doc.envVariables.map((ev: { key: string; value: string }) => {
        const encrypted = encryptIfNeeded(ev.value, key, oldKey);
        if (encrypted === 'error') {
          console.error(`  ERROR McpServer ${doc._id}: failed to decrypt envVariable "${ev.key}"`);
          envError = true;
          return ev;
        }
        if (encrypted) {
          anyChanged = true;
          return { key: ev.key, value: encrypted };
        }
        return ev;
      });
      if (envError) stats.errors++;
      if (anyChanged) {
        updates['envVariables'] = newEnvVars;
      }
    }

    // Encrypt webhook secret
    const webhookSecret = doc.metadata?.webhooks?.github?.secret;
    if (webhookSecret) {
      const encrypted = encryptIfNeeded(webhookSecret, key, oldKey);
      if (encrypted === 'error') {
        console.error(`  ERROR McpServer ${doc._id}: failed to decrypt webhook secret`);
        stats.errors++;
      } else if (encrypted) {
        updates['metadata.webhooks.github.secret'] = encrypted;
      }
    }

    if (Object.keys(updates).length === 0) {
      stats.skipped++;
      continue;
    }

    const action = REENCRYPT ? 're-encrypting' : 'encrypting';
    console.log(`  McpServer ${doc._id} (${doc.name}): ${action} ${Object.keys(updates).join(', ')}`);

    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: updates });
        stats.encrypted += Object.keys(updates).length;
      } catch (err) {
        console.error(`  ERROR McpServer ${doc._id}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted += Object.keys(updates).length;
    }
  }

  console.log(`McpServers: ${stats.encrypted} fields encrypted, ${stats.skipped} skipped`);
  return stats;
}

async function migrateOrgSlackWorkspaces(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'orgslackworkspaces', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('orgslackworkspaces');

  const cursor = collection.find({ slackBotToken: { $exists: true, $ne: '' } });

  for await (const doc of cursor) {
    stats.scanned++;
    const encrypted = encryptIfNeeded(doc.slackBotToken, key, oldKey);

    if (encrypted === 'error') {
      console.error(`  ERROR OrgSlackWorkspace ${doc._id}: failed to decrypt slackBotToken`);
      stats.errors++;
      continue;
    }

    if (!encrypted) {
      stats.skipped++;
      continue;
    }

    const action = REENCRYPT ? 're-encrypting' : 'encrypting';
    console.log(`  OrgSlackWorkspace ${doc._id}: ${action} slackBotToken`);

    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { slackBotToken: encrypted } });
        stats.encrypted++;
      } catch (err) {
        console.error(`  ERROR OrgSlackWorkspace ${doc._id}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted++;
    }
  }

  console.log(`OrgSlackWorkspaces: ${stats.encrypted} encrypted, ${stats.skipped} skipped`);
  return stats;
}

async function migrateSlackDevWorkspaces(db: mongoose.mongo.Db, key: string, oldKey?: string): Promise<MigrationStats> {
  const stats: MigrationStats = { collection: 'slackdevworkspaces', scanned: 0, encrypted: 0, skipped: 0, errors: 0 };
  const collection = db.collection('slackdevworkspaces');

  const cursor = collection.find({ slackBotToken: { $exists: true, $ne: '' } });

  for await (const doc of cursor) {
    stats.scanned++;
    const encrypted = encryptIfNeeded(doc.slackBotToken, key, oldKey);

    if (encrypted === 'error') {
      console.error(`  ERROR SlackDevWorkspace ${doc._id}: failed to decrypt slackBotToken`);
      stats.errors++;
      continue;
    }

    if (!encrypted) {
      stats.skipped++;
      continue;
    }

    const action = REENCRYPT ? 're-encrypting' : 'encrypting';
    console.log(`  SlackDevWorkspace ${doc._id}: ${action} slackBotToken`);

    if (!DRY_RUN) {
      try {
        await collection.updateOne({ _id: doc._id }, { $set: { slackBotToken: encrypted } });
        stats.encrypted++;
      } catch (err) {
        console.error(`  ERROR SlackDevWorkspace ${doc._id}:`, err);
        stats.errors++;
      }
    } else {
      stats.encrypted++;
    }
  }

  console.log(`SlackDevWorkspaces: ${stats.encrypted} encrypted, ${stats.skipped} skipped`);
  return stats;
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
