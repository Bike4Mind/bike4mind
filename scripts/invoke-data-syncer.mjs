#!/usr/bin/env node

/**
 * Invoke DataSyncer Lambda
 *
 * This script invokes the DataSyncer Lambda function to sync data:
 * - Rapid reply mappings: Always synced from production B4M API
 * - Preview settings: Synced from staging MongoDB (only when SYNC_PREVIEW_SETTINGS=true)
 *
 * Environment Variables:
 * - SYNC_RAPID_REPLY_MAPPINGS: Set to 'true' to enable sync (required)
 * - SYNC_PREVIEW_SETTINGS: Set to 'true' to sync adminsettings from staging (initial PR deploy only)
 * - AWS_REGION: AWS region (default: us-east-2)
 *
 * Usage:
 *   SYNC_RAPID_REPLY_MAPPINGS=true SYNC_PREVIEW_SETTINGS=true npx sst shell --stage <stage> -- node scripts/invoke-data-syncer.mjs
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const SYNC_RAPID_REPLY_MAPPINGS = process.env.SYNC_RAPID_REPLY_MAPPINGS === 'true';
const SYNC_PREVIEW_SETTINGS = process.env.SYNC_PREVIEW_SETTINGS === 'true';

async function invokeDataSyncer() {
  console.log('=== DataSyncer Invocation ===');
  console.log(`Stage: ${Resource.App.stage}`);
  console.log(`Region: ${AWS_REGION}`);
  console.log(`SYNC_RAPID_REPLY_MAPPINGS: ${SYNC_RAPID_REPLY_MAPPINGS}`);
  console.log(`SYNC_PREVIEW_SETTINGS: ${SYNC_PREVIEW_SETTINGS}`);

  if (!SYNC_RAPID_REPLY_MAPPINGS) {
    console.log('\n⏭️  SYNC_RAPID_REPLY_MAPPINGS is not enabled. Skipping DataSyncer invocation.');
    console.log('Set SYNC_RAPID_REPLY_MAPPINGS=true to enable data sync.');
    return;
  }

  try {
    const lambdaClient = new LambdaClient({ region: AWS_REGION });

    console.log(`\n📡 Invoking DataSyncer Lambda: ${Resource.DataSyncer.name}`);

    const command = new InvokeCommand({
      FunctionName: Resource.DataSyncer.name,
      InvocationType: 'RequestResponse', // Wait for response
      Payload: JSON.stringify({
        syncPreviewSettings: SYNC_PREVIEW_SETTINGS,
      }),
    });

    const response = await lambdaClient.send(command);

    // Parse response payload
    const payload = JSON.parse(new TextDecoder().decode(response.Payload));

    console.log('\n✅ DataSyncer Response:');
    console.log(JSON.stringify(payload, null, 2));

    if (payload.success) {
      console.log('\n✅ DataSyncer completed successfully!');
      if (payload.rapidReplySyncedCount !== undefined) {
        console.log(`📊 Rapid Reply: Synced ${payload.rapidReplySyncedCount} mappings`);
      }
      if (payload.previewSettingsSyncedCount !== undefined && payload.previewSettingsSyncedCount > 0) {
        console.log(`📊 Preview Settings: Synced ${payload.previewSettingsSyncedCount} documents from staging (adminsettings)`);
      }
    } else {
      console.warn('\n⚠️  DataSyncer completed with warnings:');
      console.warn(payload.message);
    }
  } catch (error) {
    console.error('\n❌ Error invoking DataSyncer:');
    console.error(error);
    console.warn('\n⚠️  DataSyncer invocation failed, but deployment will continue.');
    console.warn('The environment will use default rapid reply mappings.');
  }
}

// Run the script
invokeDataSyncer()
  .then(() => {
    console.log('\n=== DataSyncer Invocation Complete ===');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    console.warn('\n⚠️  Continuing with deployment despite error.');
    process.exit(0); // Exit with 0 to not block deployment
  });
