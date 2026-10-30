import { connectDB } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@bike4mind/server-utils/utils/config';
import { runNightlyRollup } from '@server/analytics/analyticsRollup';
import type { ScheduledEvent } from 'aws-lambda';
import { Resource } from 'sst';

// Errors propagate so the Lambda async-invoke DLQ receives the failed run.
export async function handler(event: ScheduledEvent): Promise<void> {
  const logger = new Logger();
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  const result = await runNightlyRollup(event.time, { logger });
  logger.log(`analytics rollup complete: ${JSON.stringify(result)}`);
}
