import { CounterLog, adminSettingsRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { getSettingsMap } from '@bike4mind/utils';
import { resolveSlackWebhookUrl } from '@server/integrations/slack/slack';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * Gets the total number of CounterLog for each counterName for the last 24 hours.
 */
export async function getCounterTotalsForLast24Hours(): Promise<{ [counterName: string]: number }> {
  // Central Time
  const now = dayjs().tz('America/Chicago');
  const twentyFourHoursAgo = now.subtract(24, 'hours').toDate();

  const counterLogs = await CounterLog.aggregate([
    {
      $match: {
        datetime: { $gte: twentyFourHoursAgo },
      },
    },
    {
      $group: {
        _id: '$counterName',
        total: { $sum: '$counterValue' },
      },
    },
  ]);

  const counterTotals: { [counterName: string]: number } = {};
  for (const counterLog of counterLogs) {
    counterTotals[counterLog._id] = counterLog.total;
  }

  return counterTotals;
}

export async function sendSlackReportViaWebhook(totals: any, topActivitiesCount: number) {
  // Resolve Slack incoming-webhook URL (SlackUserActivityWebhookUrl -> SlackDefaultWebhookUrl -> SLACK_WEBHOOK_URL secret)
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const slackWebhookUrl = resolveSlackWebhookUrl('SlackUserActivityWebhookUrl', settings);

  if (!slackWebhookUrl) {
    Logger.error('No SlackUserActivityWebhookUrl / SlackDefaultWebhookUrl configured in admin settings or config');
    return;
  }

  const message = formatSlackMessage(totals, topActivitiesCount);

  try {
    await axios.post(slackWebhookUrl, message);
    Logger.log('Slack report sent successfully via webhook');
  } catch (error) {
    Logger.error('Error sending Slack report via webhook:', error);
  }
}

function formatSlackMessage(totals: any, topActivitiesCount: number): object {
  const sortedTotals = Object.entries(totals)
    .sort(([, a], [, b]) => (b as number) - (a as number))
    .slice(0, topActivitiesCount);

  const fields = sortedTotals.map(([key, value]) => ({
    type: 'mrkdwn',
    text: `*${key}:* ${value}`,
  }));

  const appName = 'Bike4mind';

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📊 User Activity Report - ${appName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Last 24 Hours Summary (Top ${topActivitiesCount} Activities)*`,
        },
      },
      {
        type: 'section',
        fields: fields,
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Report generated at ${new Date().toLocaleString()}`,
          },
        ],
      },
    ],
  };
}
