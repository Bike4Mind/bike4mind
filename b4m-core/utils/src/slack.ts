import axios, { isAxiosError } from 'axios';
import { Logger } from '@bike4mind/observability';
import { getNotificationDeduplicator } from './notificationDeduplicator';
import { CloudWatchLogsEvent } from 'aws-lambda';
import * as util from 'node:util';
import * as zlib from 'node:zlib';

interface IngestParameters {
  event: CloudWatchLogsEvent;
  stage: string;
  slackUrl: string;
  // TODO: Temporary parameter for handling throttling exceptions. This should be removed once the throttling issue is resolved.
  throttlingSlackUrl?: string;
  enabledStages?: string[];
}

export const notifyEventLogsToSlack = async ({
  event,
  stage,
  slackUrl,
  throttlingSlackUrl,
  enabledStages,
}: IngestParameters) => {
  // Decode from base64 and decompress the data
  const payload = Buffer.from(event.awslogs.data, 'base64');
  const decompressed = await util.promisify(zlib.gunzip)(payload);
  const logData = JSON.parse(decompressed.toString('utf8'));

  const allowedStages = enabledStages ?? ['production'];
  if (!allowedStages.includes(stage)) return;

  /*
   * logData contains:
   *
   * {
   *   messageType: 'DATA_MESSAGE',
   *   owner: '123456789012',
   *   logGroup: '/aws/lambda/pr2608-groktool-Frontend-frontenddefaultServerFunc-5G0veq7mFEvf',
   *   logStream: '2024/11/25/[$LATEST]bdc1e702ba114803a78351d52443d217',
   *   subscriptionFilters: [
   *     'pr2608-groktool-LogMonitor-frontendErrorLogSubscription26A0FE11-LQFLJPbNJxmr'
   *   ],
   *   logEvents: [
   *     {
   *       id: '38635952488197320312891120804002758304943817288835727362',
   *       timestamp: 1732496028462,
   *       message: '2024-11-25T00:53:48.462Z\t3377e888-d8cb-4261-9887-d681d2cd556b\tERROR\t{"sessionId":"Root=1-6743ca93-7e4c11143e5cf9251819409d","method":"GET","path":"/api/settings/serverStatus","stage":"pr2608","clientIp":"136.49.141.53","severity":"error","message":"Server status: maintenance"}\n'
   *     }
   *   ]
   * }
   */
  const logEvents: { id: string; timestamp: number; message: string }[] = logData.logEvents;

  for (const logEvent of logEvents) {
    try {
      let message: string;
      let severity: string;
      let metadata: Record<string, string>;

      try {
        const logEventData = JSON.parse(logEvent.message.split('\t')[3]);
        message = logEventData.message;
        severity = logEventData.severity;
        metadata = logEventData;
      } catch (error) {
        message = logEvent.message;
        severity = 'error';
        metadata = { source: 'AWS' };
      }

      // Use deduplication for all error notifications
      const targetSlackUrl =
        message.includes('ThrottlingException: Rate exceeded') && throttlingSlackUrl ? throttlingSlackUrl : slackUrl;

      await getNotificationDeduplicator().handleErrorNotification(
        message,
        severity,
        metadata,
        logData,
        logEvent,
        stage,
        targetSlackUrl
      );
    } catch (error) {
      Logger.globalInstance.error(`Error: ${error}\n\tLog Event: ${JSON.stringify(logEvent)}`);
    }
  }
};

export async function postMessageToSlack(slackWebhookUrl: string, message: string): Promise<void> {
  try {
    if (!slackWebhookUrl) {
      Logger.error('postMessageToSlack: Error posting message to Slack: slackWebhookUrl is not set');
      return;
    }

    await axios.post(
      slackWebhookUrl,
      { text: message },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    Logger.error('Error posting message to Slack:', error);
  }
}

export async function postLowCreditsNotificationToSlack(
  userId: string,
  username: string,
  email: string,
  currentCredits: number,
  organization?: { id: string; name: string } | null,
  slackWebhookUrl?: string
): Promise<void> {
  try {
    if (!slackWebhookUrl) {
      Logger.error(
        'postLowCreditsNotificationToSlack: Error posting low credits notification to Slack: slackWebhookUrl not set'
      );
      Logger.error('User details:', { userId, username, email, currentCredits });
      return;
    }

    const message = `⚠️ *Low Credits Alert*\n*User:* ${username} (${email})\n*User ID:* ${userId}\n*Current Credits:* ${currentCredits}\n${
      organization ? `*Organization:* ${organization.name} (${organization.id})` : ''
    }`;

    Logger.info('Sending low credits notification to Slack:', { userId, username, currentCredits });

    await axios.post(
      slackWebhookUrl,
      { text: message },
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );

    Logger.info('Successfully sent low credits notification to Slack');
  } catch (error) {
    let errorMessage = 'Something went wrong';

    if (isAxiosError(error)) {
      errorMessage = error.response?.data.error;
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    Logger.error('Failed notification details:', { userId, username, email, currentCredits, error: errorMessage });
  }
}
