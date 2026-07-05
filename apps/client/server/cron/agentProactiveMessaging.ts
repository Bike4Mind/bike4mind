import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { sessionAgentConfigRepository, sessionRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { agentProactiveMessagingService } from '@bike4mind/services';
import { sendToQueue } from '@server/utils/sqs';

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

/**
 * Checks for eligible agents and sends them to the queue for proactive messaging.
 * Runs every hour via the agentProactiveMessageCron.
 */
export async function checkAndScheduleProactiveMessages(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  try {
    const eligibleConfigs = await agentProactiveMessagingService.getEligibleConfigs({
      db: {
        sessionAgentConfigs: sessionAgentConfigRepository,
        sessions: sessionRepository,
      },
      logger,
    });

    for (const config of eligibleConfigs) {
      try {
        await sendToQueue(Resource.agentProactiveMessageQueue.url, {
          sessionAgentConfigId: config.id,
        });

        logger.info(`Queued proactive message for agent ${config.agentId} in session ${config.sessionId}`);
      } catch (error) {
        logger.error(`Error queueing proactive message for config ${config.id}:`, error as Error);
      }
    }

    logger.info('Finished checking and queueing proactive messages');
  } catch (error) {
    logger.error('Error in checkAndScheduleProactiveMessages:', error as Error);
    throw error;
  }
}
