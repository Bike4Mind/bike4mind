/**
 * DataSyncer Lambda Handler
 *
 * Seeds a preview environment (pr* stages) with staging's config on preview deploys:
 * adminsettings (minus sensitive rows) and rapid reply mappings, copied directly between
 * the two MongoDB databases. A syncmarkers doc makes later deploys of the same preview skip.
 *
 * Triggered during deployment by scripts/invoke-data-syncer.mjs when SYNC_PREVIEW_SETTINGS=true.
 */

import { Resource } from 'sst';
import { ciphertextPatternSource } from '@bike4mind/utils/security';
import type { Handler } from 'aws-lambda';
import { MongoClient } from 'mongodb';
import '@bike4mind/server-utils/lib/settings/registerContributedSettings';
import { allSettingDefinitions } from '@bike4mind/common';

interface DataSyncerEvent {
  // Whether to sync preview settings from staging on preview deploys; the syncmarker makes repeat runs skip
  syncPreviewSettings?: boolean;
  resultVersion?: 1;
}

interface DataSyncerResponse {
  success: boolean;
  message: string;
  previewSettingsSyncedCount?: number;
  error?: string;
}

interface StrictSeedResponse {
  schemaVersion: 1;
  status: 'seeded' | 'already_seeded' | 'failed' | 'misconfigured';
  stage: string;
  copiedCount: number;
  marker?: { key: string; stage: string };
}

// Collections to sync from staging to preview environments
// rapidreplymappings: previews seed their mappings from staging, the curated source (the
// migration seed alone leaves most models with no mapping, so rapid reply is effectively off).
const COLLECTIONS_TO_SYNC = ['adminsettings', 'rapidreplymappings'];

// isSensitive admin settings are encrypted at rest under the SOURCE stage's SECRET_ENCRYPTION_KEY.
// A preview stage does not have that key linked (SST secrets are per-stage), so copying the
// ciphertext across would decrypt to '' on read - silently blanking every provider/demo key,
// Slack token, Firecrawl/Serper key and ollamaBackend at once. Never sync them cross-stage;
// previews resolve sensitive settings from their own config (or the demo-key fallback).
// Rows holding ciphertext are skipped by shape too, so an unregistered sensitive key never leaks across.
const SENSITIVE_ADMIN_SETTING_NAMES = new Set(
  allSettingDefinitions()
    .filter(def => def.isSensitive === true)
    .map(def => def.key)
);

// Settings tied to a stage's own Cloudflare Turnstile widget. Copying them would enable the challenge
// on a preview whose hostname the widget does not list; a preview opts in by setting them itself.
const PREVIEW_UNSYNCED_ADMIN_SETTING_NAMES = ['turnstileEnabled', 'turnstileFailClosed', 'turnstileSiteKey'];

// Source-side query for a synced collection. adminsettings excludes sensitive rows (above);
// every other collection copies in full. Used for BOTH the count and the cursor so the
// progress total matches what is actually inserted.
function syncSourceFilter(collectionName: string): Record<string, unknown> {
  if (collectionName === 'adminsettings') {
    return {
      settingName: { $nin: [...SENSITIVE_ADMIN_SETTING_NAMES, ...PREVIEW_UNSYNCED_ADMIN_SETTING_NAMES] },
      settingValue: { $not: new RegExp(ciphertextPatternSource, 'i') },
    };
  }
  return {};
}

// Batch size for memory-efficient streaming
const BATCH_SIZE = 1000;

const PREVIEW_STAGE_PATTERN = /^pr\d+$/;

const SYNC_MARKER_COLLECTION = 'syncmarkers';
const SYNC_MARKER_KEY = 'staging-config-sync';

// Staging MongoDB URI is provided via environment variable (from GitHub secret)
// This allows staging and preview to be on different clusters

// `skipped` names why nothing was copied, so the deploy log (which only sees the response) can tell
// an already-synced preview from a misconfigured one.
async function syncPreviewSettingsFromStaging(strict = false): Promise<{
  synced: number;
  alreadySeeded?: boolean;
  markerStage?: string;
  skipped?: string;
  emptyCollections?: string[];
}> {
  console.log('=== Syncing Preview Settings from Staging ===');

  const stage = process.env.SEED_STAGE_NAME || 'unknown';

  // Strict validation: only allow preview stages (pr<number>), never staging/production
  if (!PREVIEW_STAGE_PATTERN.test(stage)) {
    console.error(
      `✗ Error: Target stage "${stage}" is not a valid preview environment (must match pr<number>). Sync aborted for safety.`
    );
    return { synced: 0, skipped: `target stage "${stage}" is not a preview (pr<number>)` };
  }

  const stagingUri = process.env.STAGING_MONGODB_URI;
  const previewUri = Resource.MONGODB_URI.value.replace('%STAGE%', stage);

  if (!stagingUri) {
    console.log('⏭️  STAGING_MONGODB_URI not configured. Skipping preview settings sync.');
    return { synced: 0, skipped: 'STAGING_MONGODB_URI not configured' };
  }

  // Safety check: abort if source and target are the same database
  if (stagingUri === previewUri) {
    console.error('✗ Error: Source and target MongoDB URIs are identical. Sync aborted to prevent data loss.');
    return { synced: 0, skipped: 'source and target URIs are identical' };
  }

  console.log(`  Source: staging (from STAGING_MONGODB_URI)`);
  console.log(`  Target: preview (${stage})`);

  const sourceClient = new MongoClient(stagingUri);
  const targetClient = new MongoClient(previewUri);

  let totalSynced = 0;
  const skippedCollections: string[] = [];

  try {
    // Connect to target first to check sync marker
    await targetClient.connect();
    const targetDb = targetClient.db();

    // Skip if already synced for this preview environment
    const existingMarker = await targetDb.collection(SYNC_MARKER_COLLECTION).findOne({ key: SYNC_MARKER_KEY });
    if (existingMarker) {
      const markerDoc = existingMarker as { syncedAt?: Date; stage?: string };
      if (strict && markerDoc.stage !== stage) throw new Error('Sync marker stage does not match');
      console.log(`✓ Staging configs already synced at ${markerDoc.syncedAt?.toISOString()}, skipping`);
      console.log('  (To force re-sync, delete the marker from the syncmarkers collection)');
      return {
        synced: 0,
        alreadySeeded: true,
        markerStage: markerDoc.stage,
        skipped: `already synced at ${markerDoc.syncedAt?.toISOString()}`,
      };
    }

    await sourceClient.connect();
    console.log('  ✓ Connected to SOURCE (Staging)');
    console.log('  ✓ Connected to TARGET (Preview)');

    const sourceDb = sourceClient.db();

    for (const collectionName of COLLECTIONS_TO_SYNC) {
      console.log(`\n📦 Syncing collection: ${collectionName}`);

      const sourceCollection = sourceDb.collection(collectionName);
      const targetCollection = targetDb.collection(collectionName);
      const backupCollectionName = `${collectionName}_backup_temp`;
      const backupCollection = targetDb.collection(backupCollectionName);

      const sourceFilter = syncSourceFilter(collectionName);
      if (Object.keys(sourceFilter).length > 0) {
        console.log(
          `  - Excluding ${SENSITIVE_ADMIN_SETTING_NAMES.size} sensitive settings (encrypted under the source ` +
            `stage's key; a preview cannot decrypt them) and ${PREVIEW_UNSYNCED_ADMIN_SETTING_NAMES.length} ` +
            `stage-specific settings from the cross-stage sync.`
        );
      }

      const totalDocs = await sourceCollection.countDocuments(sourceFilter);

      if (totalDocs === 0) {
        console.log(`  - No documents found in ${collectionName}. Skipping.`);
        skippedCollections.push(collectionName);
        continue;
      }

      console.log(`  - Found ${totalDocs} documents in source.`);

      // Rollback touches the target only once its backup is complete, i.e. from the clear on:
      // before that the target is intact and the backup may be partial. Set before the clear
      // because deleteMany is not atomic and can fail with the target half-deleted.
      let backupComplete = false;
      try {
        // Drop any stale backup from a previous failed run
        await backupCollection.drop().catch((err: Error) => {
          if (!err.message.includes('ns not found')) {
            console.warn(`  ⚠ Warning: Failed to drop stale backup ${backupCollectionName}:`, err.message);
          }
        });

        // Create backup of existing target data before replacing
        const existingDocs = await targetCollection.countDocuments({});
        if (existingDocs > 0) {
          console.log(`  - Creating backup of ${existingDocs} existing documents...`);
          const existingDocsCursor = targetCollection.find({});
          let backupBatch: Record<string, unknown>[] = [];
          for await (const doc of existingDocsCursor) {
            backupBatch.push(doc as Record<string, unknown>);
            if (backupBatch.length === BATCH_SIZE) {
              await backupCollection.insertMany(backupBatch, { ordered: false });
              backupBatch = [];
            }
          }
          if (backupBatch.length > 0) {
            await backupCollection.insertMany(backupBatch, { ordered: false });
          }
          console.log(`  - Backup created in ${backupCollectionName}`);
        }

        backupComplete = true;
        const deleteResult = await targetCollection.deleteMany({});
        console.log(`  - Cleared ${deleteResult.deletedCount} existing documents in target.`);

        // Stream documents from source and insert into target in batches
        const cursor = sourceCollection.find(sourceFilter);
        let batch: Record<string, unknown>[] = [];
        let insertedCount = 0;

        for await (const doc of cursor) {
          batch.push(doc as Record<string, unknown>);
          if (batch.length === BATCH_SIZE) {
            const batchResult = await targetCollection.insertMany(batch, { ordered: false });
            insertedCount += batchResult.insertedCount;
            batch = [];
            console.log(`    ... synced ${insertedCount}/${totalDocs}`);
          }
        }

        if (batch.length > 0) {
          const batchResult = await targetCollection.insertMany(batch, { ordered: false });
          insertedCount += batchResult.insertedCount;
        }

        if (strict && insertedCount !== totalDocs) throw new Error('Source copy was incomplete');
        console.log(`  ✓ Sync complete: ${insertedCount} documents.`);
        totalSynced += insertedCount;

        // Clean up backup after successful sync
        await backupCollection.drop().catch((err: Error) => {
          if (!err.message.includes('ns not found')) {
            console.warn(`  ⚠ Warning: Failed to clean up backup ${backupCollectionName}:`, err.message);
          }
        });
      } catch (error) {
        console.error(`  ✗ Error syncing ${collectionName}:`, error instanceof Error ? error.message : error);

        if (backupComplete) {
          try {
            // Clear partial inserts first: they are not in the backup and can collide with it on
            // unique indexes (e.g. rapidreplymappings.mainModelId), failing the upserts below.
            await targetCollection.deleteMany({});
            const backupDocs = await backupCollection.find({}).toArray();
            const backupCount = backupDocs.length;
            console.log(`  - Attempting rollback from backup (${backupCount} documents)...`);
            const bulkOps = backupDocs.map(doc => ({
              replaceOne: {
                filter: { _id: doc._id },
                replacement: doc as Record<string, unknown>,
                upsert: true,
              },
            }));
            if (bulkOps.length > 0) {
              await targetCollection.bulkWrite(bulkOps, { ordered: false });
            }
            console.log(`  ✓ Rolled back ${backupCount} documents from backup`);
            await backupCollection.drop().catch((err: Error) => {
              if (!err.message.includes('ns not found')) {
                console.warn(`  ⚠ Warning: Failed to drop backup after rollback:`, err.message);
              }
            });
          } catch (rollbackError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            console.error(
              `  ✗ Rollback failed:`,
              rollbackError instanceof Error ? rollbackError.message : rollbackError
            );
            throw new Error(
              `Sync of ${collectionName} failed: ${originalMessage} (rollback also failed: ${rollbackMessage})`,
              { cause: error }
            );
          }
        } else {
          console.log('  - Target was not modified yet; leaving it untouched.');
        }

        throw error;
      }
    }

    // An all-empty source points at a misconfigured staging, so leave the marker unset and retry.
    // A single empty collection is a normal state and must not make later deploys re-copy.
    if (totalSynced === 0) {
      const allSourcesEmpty = skippedCollections.length === COLLECTIONS_TO_SYNC.length;
      const reason = allSourcesEmpty
        ? `source was empty for ${skippedCollections.join(', ')}`
        : 'no documents were copied';
      console.log(`  - Sync marker not set: ${reason}`);
      return {
        synced: 0,
        skipped: allSourcesEmpty
          ? 'source empty for all collections; will retry next deploy'
          : 'no documents copied; will retry next deploy',
      };
    }

    // Mark sync as complete so subsequent deploys skip this step
    await targetDb
      .collection(SYNC_MARKER_COLLECTION)
      .updateOne(
        { key: SYNC_MARKER_KEY },
        { $set: { key: SYNC_MARKER_KEY, stage, syncedAt: new Date() } },
        { upsert: true }
      );
    if (strict) {
      const marker = await targetDb.collection(SYNC_MARKER_COLLECTION).findOne({ key: SYNC_MARKER_KEY, stage });
      if (marker?.stage !== stage) throw new Error('Sync marker was not persisted');
    }
    console.log('  ✓ Sync marker set');

    console.log(`\n✓ Preview settings sync complete: ${totalSynced} total documents synced`);
  } finally {
    await sourceClient.close();
    await targetClient.close();
    console.log('✓ MongoDB connections closed');
  }

  return { synced: totalSynced, markerStage: stage, emptyCollections: skippedCollections };
}

async function strictSeed(event: DataSyncerEvent): Promise<StrictSeedResponse> {
  const rawStage = process.env.SEED_STAGE_NAME ?? '';
  const stage = /^pr[1-9][0-9]*$/.test(rawStage) ? rawStage : '';
  const result = (status: StrictSeedResponse['status']): StrictSeedResponse => ({
    schemaVersion: 1,
    status,
    stage,
    copiedCount: 0,
  });
  try {
    const uri = Resource.MONGODB_URI?.value;
    const stagingUri = process.env.STAGING_MONGODB_URI;
    if (
      !stage ||
      !uri ||
      !stagingUri ||
      event.syncPreviewSettings !== true ||
      uri.replace('%STAGE%', stage) === stagingUri
    ) {
      return result('misconfigured');
    }
    const synced = await syncPreviewSettingsFromStaging(true);
    if (synced.markerStage !== stage || (!synced.alreadySeeded && synced.synced <= 0)) return result('failed');
    return {
      schemaVersion: 1,
      status: synced.alreadySeeded ? 'already_seeded' : 'seeded',
      stage,
      copiedCount: synced.synced,
      marker: { key: SYNC_MARKER_KEY, stage },
    };
  } catch (error) {
    // Driver messages can contain connection strings; log only safe diagnostic fields.
    const errorType = error instanceof Error && /^Mongo[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error';
    const errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
    const invariantFailures = [
      'Sync marker stage does not match',
      'Source copy was incomplete',
      'Sync marker was not persisted',
    ];
    const reason = error instanceof Error && invariantFailures.includes(error.message) ? error.message : undefined;
    console.error('Preview seed failed', { stage, errorType, errorCode, reason });
    return result('failed');
  }
}

export const handler: Handler<DataSyncerEvent, DataSyncerResponse | StrictSeedResponse> = async event => {
  if (event.resultVersion === 1) return strictSeed(event);
  console.log('DataSyncer invoked with event:', event);

  const isPreviewEnvironment = PREVIEW_STAGE_PATTERN.test(process.env.SEED_STAGE_NAME ?? '');
  // syncPreviewSettings is passed from the invoke script on preview deploys; the syncmarker makes repeat runs skip
  const shouldSyncPreviewSettings = event.syncPreviewSettings === true;

  console.log(
    `Environment check: SEED_STAGE_NAME=${process.env.SEED_STAGE_NAME}, isPreviewEnvironment=${isPreviewEnvironment}, shouldSyncPreviewSettings=${shouldSyncPreviewSettings}`
  );

  let previewSettingsSyncedCount = 0;
  const messages: string[] = [];

  try {
    if (!Resource.MONGODB_URI?.value) {
      throw new Error('MONGODB_URI secret is not configured');
    }

    // Validate that SEED_STAGE_NAME is set for %STAGE% replacement
    if (!process.env.SEED_STAGE_NAME) {
      throw new Error('SEED_STAGE_NAME environment variable is not set - required for MONGODB_URI stage replacement');
    }

    // Sync preview settings from staging on preview deploys; the syncmarker makes repeat runs skip
    if (shouldSyncPreviewSettings) {
      try {
        const { synced, skipped, emptyCollections } = await syncPreviewSettingsFromStaging();
        previewSettingsSyncedCount = synced;
        const collectionsStr = COLLECTIONS_TO_SYNC.join(', ');
        messages.push(
          skipped
            ? `Skipped staging sync: ${skipped}`
            : `Synced ${synced} documents from staging (collections: ${collectionsStr})` +
                (emptyCollections?.length ? `; empty in source: ${emptyCollections.join(', ')}` : '')
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error syncing preview settings from staging:', error);
        messages.push(`Preview settings sync failed: ${errorMsg}`);
      }
    } else {
      console.log('⏭️  Skipping preview settings sync (SYNC_PREVIEW_SETTINGS not enabled)');
      messages.push('Skipped preview settings sync (SYNC_PREVIEW_SETTINGS not enabled)');
    }

    return {
      success: true,
      message: messages.length > 0 ? messages.join('; ') : 'No sync operations performed',
      previewSettingsSyncedCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in DataSyncer:', error);

    // Log warning but don't fail deployment
    console.warn('WARNING: DataSyncer failed but will not block deployment');

    return {
      success: true, // Return success to not block deployment
      message: `Warning: Sync failed but deployment will continue. Error: ${errorMessage}`,
      error: errorMessage,
      previewSettingsSyncedCount,
    };
  }
};
