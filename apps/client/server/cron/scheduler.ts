import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';
import { taskSchedulerService } from '@bike4mind/services';
import { taskScheduleRepository, connectDB } from '@bike4mind/database';
import { TaskScheduleHandler } from '@bike4mind/common';
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

// TODO: HANDLE CLEANUPS FOR THE DATA THA HAS BEEN PROCESSED
export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);

  await taskSchedulerService.process({
    db: {
      taskSchedules: taskScheduleRepository,
    },
    logger,
    handlers: {
      [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: async payload => {
        await sendToQueue(Resource.researchEngineQueue.url, payload);
      },
      [TaskScheduleHandler.CUSTOM_TASK_PROCESS]: async payload => {
        console.log('CUSTOM_TASK_PROCESS', payload);
      },
    },
  });
}
