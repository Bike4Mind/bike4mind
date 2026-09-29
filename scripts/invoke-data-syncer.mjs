#!/usr/bin/env node

/**
 * Invoke DataSyncer Lambda
 *
 * This script invokes the DataSyncer Lambda function, which copies adminsettings and rapid
 * reply mappings from staging MongoDB into a preview environment on its first deploy.
 *
 * Environment Variables:
 * - SYNC_PREVIEW_SETTINGS: Set to 'true' to run the sync (preview deploys only; otherwise skipped)
 * - AWS_REGION: AWS region (default: us-east-2)
 *
 * Usage:
 *   SYNC_PREVIEW_SETTINGS=true npx sst shell --stage <stage> -- node scripts/invoke-data-syncer.mjs
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Resource } from 'sst';

const AWS_REGION = process.env.AWS_REGION || 'us-east-2';
const SYNC_PREVIEW_SETTINGS = process.env.SYNC_PREVIEW_SETTINGS === 'true';

async function invokeDataSyncer() {
  console.log('=== DataSyncer Invocation ===');
  console.log(`Stage: ${Resource.App.stage}`);
  console.log(`Region: ${AWS_REGION}`);
  console.log(`SYNC_PREVIEW_SETTINGS: ${SYNC_PREVIEW_SETTINGS}`);

  if (!SYNC_PREVIEW_SETTINGS) {
    console.log('\nSYNC_PREVIEW_SETTINGS is not enabled (not a preview deploy). Skipping DataSyncer invocation.');
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
      if (payload.previewSettingsSyncedCount !== undefined && payload.previewSettingsSyncedCount > 0) {
        console.log(`📊 Preview Settings: Synced ${payload.previewSettingsSyncedCount} documents from staging (adminsettings, rapidreplymappings)`);
      }
    } else {
      console.warn('\n⚠️  DataSyncer completed with warnings:');
      console.warn(payload.message);
    }
  } catch (error) {
    console.error('\n❌ Error invoking DataSyncer:');
    console.error(error);
    console.warn('\n⚠️  DataSyncer invocation failed, but deployment will continue.');
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
