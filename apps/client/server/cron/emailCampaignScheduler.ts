import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { emailJobRepository, connectDB } from '@bike4mind/database';
import { EmailJobStatus } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { sendToQueue } from '@server/utils/sqs';
import { Resource } from 'sst';
import { Config } from '@server/utils/config';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Cron handler that processes scheduled email campaigns.
 * Runs every 5 minutes to check for campaigns that are due to be sent.
 */
export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  logger.info('Checking for scheduled email campaigns');

  const dueJobs = await emailJobRepository.findDueScheduledJobs();

  if (dueJobs.length === 0) {
    logger.info('No scheduled campaigns due');
    return;
  }

  logger.info(`Found ${dueJobs.length} scheduled campaigns due for processing`);

  for (const job of dueJobs) {
    try {
      await emailJobRepository.update({
        id: job.id,
        status: EmailJobStatus.QUEUED,
        startedBy: 'scheduler',
      });

      await sendToQueue(Resource.emailJobQueue.url, {
        jobId: job.id,
      });

      logger.info(`Queued scheduled campaign: ${job.name} (${job.id})`);
    } catch (error) {
      logger.error(`Failed to queue scheduled campaign ${job.id}:`, error);
      // Don't throw - let other jobs continue processing
    }
  }

  logger.info(`Finished processing ${dueJobs.length} scheduled campaigns`);
}
