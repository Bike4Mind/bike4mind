import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB } from '@bike4mind/database';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';
import { runAllProbes } from '@server/services/integrationHealthService';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Cron handler: Integration Health Check
 * Runs every 5 minutes to probe all external integration APIs.
 * Each probe runs concurrently and is isolated - one failure won't block others.
 */
export async function handler(_event: unknown, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    logger.log('Integration health check started');

    const results = await runAllProbes(logger);

    const summary = results.map(r => ({
      integration: r.integration,
      status: r.status,
      latencyMs: r.latencyMs,
      error: r.error,
    }));

    logger.log('Integration health check complete', { results: summary });

    return {
      status: 'success',
      probesRun: results.length,
      results: summary,
    };
  } catch (error) {
    logger.error('Integration health check cron failed', { error });
    return { status: 'error', error: String(error) };
  }
}
