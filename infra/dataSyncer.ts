/**
 * DataSyncer Lambda Infrastructure
 *
 * Lambda function that copies staging config (adminsettings, rapid reply mappings) from
 * staging MongoDB into a preview environment on its first deploy.
 *
 * Invoked during deployment by scripts/invoke-data-syncer.mjs when SYNC_PREVIEW_SETTINGS=true.
 */

import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { secrets } from './secrets';
import { lambdaVpc } from './vpc';

/**
 * DataSyncer Lambda Function
 *
 * Copies adminsettings and rapidreplymappings from staging into a preview (pr*) stage,
 * once per preview (guarded by a syncmarkers doc in the target).
 *
 * Environment Variables:
 * - SEED_STAGE_NAME: Stage name for MongoDB URI replacement (must be pr<number> to sync)
 * - STAGING_MONGODB_URI: Source staging database (sync is skipped when empty)
 *
 * Secrets:
 * - MONGODB_URI: Connection string template with %STAGE% placeholder
 */
export const dataSyncer = new sst.aws.Function('DataSyncer', {
  handler: 'apps/client/server/jobs/dataSyncerHandler.handler',
  timeout: '5 minutes', // Generous timeout for copying collections
  memory: '512 MB',
  vpc: lambdaVpc,
  link: [secrets.MONGODB_URI],
  logging: {
    retention: '3 days',
  },
  environment: {
    ...DEFAULT_LAMBDA_ENVIRONMENT,
    SEED_STAGE_NAME: process.env.SEED_STAGE_NAME || $app.stage,
    // Staging MongoDB URI for syncing staging config to preview environments
    // Set via GitHub secret STAGING_MONGODB_URI
    STAGING_MONGODB_URI: process.env.STAGING_MONGODB_URI || '',
  },
});
