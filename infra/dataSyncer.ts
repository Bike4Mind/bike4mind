/**
 * DataSyncer Lambda Infrastructure
 *
 * Lambda function that syncs data to non-production environments:
 * 1. Rapid reply mappings from production B4M API
 * 2. Admin settings from staging MongoDB (for preview environments)
 *
 * Invoked once during deployment when SYNC_RAPID_REPLY_MAPPINGS=true.
 */

import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { secrets } from './secrets';
import { lambdaVpc } from './vpc';

/**
 * DataSyncer Lambda Function
 *
 * Syncs rapid reply mappings from production B4M to current environment.
 * For preview environments (pr*), also syncs adminsettings from staging MongoDB.
 * Runs once per deployment when SYNC_RAPID_REPLY_MAPPINGS=true.
 *
 * Environment Variables:
 * - SYNC_RAPID_REPLY_MAPPINGS: Set to 'true' to enable sync (default: false)
 * - SEED_STAGE_NAME: Stage name for MongoDB URI replacement
 *
 * Secrets:
 * - B4M_PROD_API_KEY: API key for authenticating with production B4M API
 * - MONGODB_URI: Connection string template with %STAGE% placeholder
 */
export const dataSyncer = new sst.aws.Function('DataSyncer', {
  handler: 'apps/client/server/jobs/dataSyncerHandler.handler',
  timeout: '5 minutes', // Generous timeout for fetching and writing mappings
  memory: '512 MB',
  vpc: lambdaVpc,
  link: [secrets.MONGODB_URI, secrets.B4M_PROD_API_KEY],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    SYNC_RAPID_REPLY_MAPPINGS: process.env.SYNC_RAPID_REPLY_MAPPINGS || 'false',
    SEED_STAGE_NAME: process.env.SEED_STAGE_NAME || $app.stage,
    // Staging MongoDB URI for syncing adminsettings to preview environments
    // Set via GitHub secret STAGING_MONGODB_URI
    STAGING_MONGODB_URI: process.env.STAGING_MONGODB_URI || '',
  },
});

// Log whether sync is enabled
if (process.env.SYNC_RAPID_REPLY_MAPPINGS === 'true') {
  console.log('SYNC_RAPID_REPLY_MAPPINGS=true: DataSyncer will sync mappings when invoked');
} else {
  console.log('SYNC_RAPID_REPLY_MAPPINGS not enabled: DataSyncer will skip sync if invoked');
}
