/**
 * DataSyncer Lambda Handler
 *
 * Syncs data from production B4M to the current environment:
 * 1. Rapid reply mappings - always synced when handler is invoked
 * 2. Preview settings - only synced for preview environments (pr* stages)
 *
 * Triggered during deployment via GitHub Actions workflow when:
 * - vars.SYNC_RAPID_REPLY_MAPPINGS=true (staging/customer staging)
 * - OR it's a preview environment (unless explicitly disabled)
 *
 * Flow:
 * 1. Fetch rapid reply mappings from production B4M API using B4M_PROD_API_KEY
 * 2. Clear existing mappings and insert fresh data from production
 * 3. If preview environment (pr*): Sync adminsettings collection directly from staging MongoDB
 */

import { Resource } from 'sst';
import type { Handler } from 'aws-lambda';
import mongoose from 'mongoose';
import { MongoClient } from 'mongodb';
import { isPlaceholderValue } from '@bike4mind/common';
import { rapidReplyMappingRepository } from '@bike4mind/database/ai';

interface DataSyncerEvent {
  // Whether to sync preview settings from staging (only on initial PR deploy)
  syncPreviewSettings?: boolean;
}

interface DataSyncerResponse {
  success: boolean;
  message: string;
  rapidReplySyncedCount?: number;
  previewSettingsSyncedCount?: number;
  error?: string;
}

// Production app URL this non-prod job pulls config FROM. Must be the PRODUCTION host (not the
// deploying stage's SERVER_DOMAIN), so it derives from PROD_SERVER_DOMAIN - the account-tied
// production domain, available on every stage with no brand fallback. Empty when
// unconfigured, in which case the sync is skipped/fails fast rather than hitting the wrong host.
const PRODUCTION_B4M_URL = process.env.PROD_SERVER_DOMAIN ? `https://app.${process.env.PROD_SERVER_DOMAIN}` : '';

// Collections to sync from staging to preview environments
const COLLECTIONS_TO_SYNC = ['adminsettings'];

// Batch size for memory-efficient streaming
const BATCH_SIZE = 1000;

const SYNC_MARKER_COLLECTION = 'syncmarkers';
const SYNC_MARKER_KEY = 'staging-config-sync';

// Staging MongoDB URI is provided via environment variable (from GitHub secret)
// This allows staging and preview to be on different clusters

async function syncRapidReplyMappings(): Promise<number> {
  console.log('=== Syncing Rapid Reply Mappings ===');
  console.log('Connecting to MongoDB via mongoose...');

  // Replace %STAGE% placeholder in MONGODB_URI with actual stage name
  const stage = process.env.SEED_STAGE_NAME || 'unknown';
  const mongodbUri = Resource.MONGODB_URI.value.replace('%STAGE%', stage);

  await mongoose.connect(mongodbUri);

  console.log('Fetching rapid reply mappings from production...');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout for production sync

  let response: Response;
  try {
    response = await fetch(`${PRODUCTION_B4M_URL}/api/admin/rapid-reply/mappings`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': Resource.B4M_PROD_API_KEY.value,
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (fetchError) {
    clearTimeout(timeoutId);
    if (fetchError instanceof Error && fetchError.name === 'AbortError') {
      console.warn('WARNING: Fetch from production timed out after 30s');
      return 0;
    }
    throw fetchError;
  }

  if (!response.ok) {
    const errorText = await response.text();
    console.warn(
      `WARNING: Failed to fetch rapid reply mappings from production. Status: ${response.status}. Error: ${errorText}`
    );
    return 0;
  }

  const data = (await response.json()) as { mappings: unknown[] };

  if (!data.mappings || !Array.isArray(data.mappings)) {
    console.warn('WARNING: Production response did not contain mappings array');
    return 0;
  }

  console.log(`Fetched ${data.mappings.length} rapid reply mappings from production`);

  if (data.mappings.length === 0) {
    console.log('No mappings to sync from production');
    return 0;
  }

  console.log('Clearing existing rapid reply mappings...');
  const existingMappings = await rapidReplyMappingRepository.findAll();
  for (const mapping of existingMappings) {
    await rapidReplyMappingRepository.deleteMapping(mapping.id);
  }
  console.log(`Cleared ${existingMappings.length} existing mappings`);

  console.log('Inserting new mappings from production...');
  let syncedCount = 0;
  for (const mapping of data.mappings) {
    try {
      const mappingRecord = mapping as Record<string, unknown>;
      const { _id, id, createdAt, updatedAt, ...mappingData } = mappingRecord;

      await rapidReplyMappingRepository.createMapping({
        ...(mappingData as Parameters<typeof rapidReplyMappingRepository.createMapping>[0]),
        createdBy: 'system-sync',
      });
      syncedCount++;
    } catch (error) {
      const mappingRecord = mapping as Record<string, unknown>;
      console.error(`Failed to insert mapping for mainModelId ${mappingRecord.mainModelId}:`, error);
    }
  }

  console.log(`Successfully synced ${syncedCount} of ${data.mappings.length} rapid reply mappings`);
  return syncedCount;
}

async function syncPreviewSettingsFromStaging(): Promise<number> {
  console.log('=== Syncing Preview Settings from Staging ===');

  const stage = process.env.SEED_STAGE_NAME || 'unknown';

  // Strict validation: only allow preview stages (pr<number>), never staging/production
  if (!/^pr\d+$/.test(stage)) {
    console.error(
      `✗ Error: Target stage "${stage}" is not a valid preview environment (must match pr<number>). Sync aborted for safety.`
    );
    return 0;
  }

  const stagingUri = process.env.STAGING_MONGODB_URI;
  const previewUri = Resource.MONGODB_URI.value.replace('%STAGE%', stage);

  if (!stagingUri) {
    console.log('⏭️  STAGING_MONGODB_URI not configured. Skipping preview settings sync.');
    return 0;
  }

  // Safety check: abort if source and target are the same database
  if (stagingUri === previewUri) {
    console.error('✗ Error: Source and target MongoDB URIs are identical. Sync aborted to prevent data loss.');
    return 0;
  }

  console.log(`  Source: staging (from STAGING_MONGODB_URI)`);
  console.log(`  Target: preview (${stage})`);

  const sourceClient = new MongoClient(stagingUri);
  const targetClient = new MongoClient(previewUri);

  let totalSynced = 0;

  try {
    // Connect to target first to check sync marker
    await targetClient.connect();
    const targetDb = targetClient.db();

    // Skip if already synced for this preview environment
    const existingMarker = await targetDb.collection(SYNC_MARKER_COLLECTION).findOne({ key: SYNC_MARKER_KEY });
    if (existingMarker) {
      const markerDoc = existingMarker as { syncedAt?: Date };
      console.log(`✓ Staging configs already synced at ${markerDoc.syncedAt?.toISOString()}, skipping`);
      console.log('  (To force re-sync, delete the marker from the syncmarkers collection)');
      return 0;
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

      const totalDocs = await sourceCollection.countDocuments({});

      if (totalDocs === 0) {
        console.log(`  - No documents found in ${collectionName}. Skipping.`);
        continue;
      }

      console.log(`  - Found ${totalDocs} documents in source.`);

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

        const deleteResult = await targetCollection.deleteMany({});
        console.log(`  - Cleared ${deleteResult.deletedCount} existing documents in target.`);

        // Stream documents from source and insert into target in batches
        const cursor = sourceCollection.find({});
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

        // Attempt rollback from backup
        const backupCount = await backupCollection.countDocuments({});
        if (backupCount > 0) {
          console.log(`  - Attempting rollback from backup (${backupCount} documents)...`);
          try {
            const backupDocs = await backupCollection.find({}).toArray();
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
            console.error(
              `  ✗ Rollback failed:`,
              rollbackError instanceof Error ? rollbackError.message : rollbackError
            );
          }
        }

        throw error;
      }
    }

    // Mark sync as complete so subsequent deploys skip this step
    await targetDb
      .collection(SYNC_MARKER_COLLECTION)
      .updateOne({ key: SYNC_MARKER_KEY }, { $set: { key: SYNC_MARKER_KEY, syncedAt: new Date() } }, { upsert: true });
    console.log('  ✓ Sync marker set');

    console.log(`\n✓ Preview settings sync complete: ${totalSynced} total documents synced`);
  } finally {
    await sourceClient.close();
    await targetClient.close();
    console.log('✓ MongoDB connections closed');
  }

  return totalSynced;
}

export const handler: Handler<DataSyncerEvent, DataSyncerResponse> = async event => {
  console.log('DataSyncer invoked with event:', event);

  const isPreviewEnvironment = process.env.SEED_STAGE_NAME?.startsWith('pr') || false;
  // syncPreviewSettings is passed from the invoke script, true only on initial PR deploy
  const shouldSyncPreviewSettings = event.syncPreviewSettings === true;

  console.log(
    `Environment check: SEED_STAGE_NAME=${process.env.SEED_STAGE_NAME}, isPreviewEnvironment=${isPreviewEnvironment}, shouldSyncPreviewSettings=${shouldSyncPreviewSettings}`
  );

  let rapidReplySyncedCount = 0;
  let previewSettingsSyncedCount = 0;
  const messages: string[] = [];

  try {
    // Validate required secrets
    if (!Resource.B4M_PROD_API_KEY?.value || isPlaceholderValue(Resource.B4M_PROD_API_KEY.value)) {
      throw new Error('B4M_PROD_API_KEY secret is not configured');
    }

    if (!Resource.MONGODB_URI?.value) {
      throw new Error('MONGODB_URI secret is not configured');
    }

    // Validate that SEED_STAGE_NAME is set for %STAGE% replacement
    if (!process.env.SEED_STAGE_NAME) {
      throw new Error('SEED_STAGE_NAME environment variable is not set - required for MONGODB_URI stage replacement');
    }

    // Always sync rapid reply mappings (when handler is invoked)
    try {
      rapidReplySyncedCount = await syncRapidReplyMappings();
      messages.push(`Synced ${rapidReplySyncedCount} rapid reply mappings`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error syncing rapid reply mappings:', error);
      messages.push(`Rapid reply sync failed: ${errorMsg}`);
    } finally {
      // Clean up mongoose connection
      if (mongoose.connection.readyState === 1) {
        await mongoose.connection.close();
        console.log('Mongoose connection closed');
      }
    }

    // Sync preview settings from staging (only on initial PR deploy when SYNC_PREVIEW_SETTINGS=true)
    if (shouldSyncPreviewSettings) {
      try {
        previewSettingsSyncedCount = await syncPreviewSettingsFromStaging();
        const collectionsStr = COLLECTIONS_TO_SYNC.join(', ');
        messages.push(`Synced ${previewSettingsSyncedCount} documents from staging (collections: ${collectionsStr})`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error syncing preview settings from staging:', error);
        messages.push(`Preview settings sync failed: ${errorMsg}`);
      }
    } else {
      console.log('⏭️  Skipping preview settings sync (SYNC_PREVIEW_SETTINGS not enabled)');
      messages.push('Skipped preview settings sync (not initial PR deploy)');
    }

    return {
      success: true,
      message: messages.length > 0 ? messages.join('; ') : 'No sync operations performed',
      rapidReplySyncedCount,
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
      rapidReplySyncedCount,
      previewSettingsSyncedCount,
    };
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('Final cleanup: Mongoose connection closed');
    }
  }
};
