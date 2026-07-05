#!/usr/bin/env tsx

import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { counterService } from '@bike4mind/services';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import { Resource } from 'sst';

const generateDailyReport = counterService.generateDailyReport;
const generateAIInsights = counterService.generateAIInsights;
const formatWeeklySlackMessage = counterService.formatWeeklySlackMessage;

dayjs.extend(isoWeek);

// Add SST Config type declarations

export interface ConfigTypes {
  APP: string;
  MONGODB_URI: string;
  SLACK_WEBHOOK_URL: string;
}

interface ExecutionContext {
  awsRequestId?: string;
  functionName?: string;
  functionVersion?: string;
}

const contextToLogs = (context: ExecutionContext) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName ?? 'WeeklyUserActivity',
  functionVersion: context.functionVersion ?? 'latest',
  stage: Resource.App.stage,
});

// Resolve the Slack webhook URL from admin settings, falling back to config.
async function getSlackWebhookUrl(): Promise<string | undefined> {
  try {
    const slackSetting = await adminSettingsRepository.getSettingsValue('SlackGeneralWebhookUrl');
    return slackSetting || Resource.SLACK_WEBHOOK_URL.value;
  } catch (error) {
    console.error('Error getting SlackGeneralWebhookUrl from settings:', error);
    return Resource.SLACK_WEBHOOK_URL.value;
  }
}

class WeeklyInsightsGenerator {
  private options: {
    date?: string;
    stage: string;
    apiKey: string;
  };

  constructor(options: { date?: string; stage: string; apiKey: string }) {
    this.options = options;
  }

  async run() {
    const logger = new Logger().withMetadata(contextToLogs({}));

    try {
      await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', this.options.stage), logger);
      logger.log('Connected to database');

      // Calculate the week dates
      let startDate: string;
      let endDate: string;
      let processDate: string;

      const weekSpec = process.env.WEEK;
      const today = dayjs();

      if (weekSpec) {
        // Parse YYYY-WW format
        const [year, week] = weekSpec.split('-');
        if (!year || !week) {
          throw new Error('Invalid week format. Please use YYYY-WW (e.g., 2024-01)');
        }
        const weekNum = parseInt(week, 10);
        if (isNaN(weekNum) || weekNum < 1 || weekNum > 53) {
          throw new Error('Invalid week number. Must be between 1 and 53');
        }

        // Set to the Monday of the specified week
        const date = dayjs().year(parseInt(year)).isoWeek(weekNum).startOf('isoWeek');
        startDate = date.format('YYYY-MM-DD');
        endDate = date.add(6, 'days').format('YYYY-MM-DD');

        // If it's a past week, use end of day on Sunday
        processDate = dayjs(endDate).isBefore(today, 'day')
          ? dayjs(endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss.SSS')
          : endDate;
      } else {
        // Default to current week
        startDate = today.startOf('isoWeek').format('YYYY-MM-DD'); // Current week's Monday
        endDate = today.endOf('isoWeek').format('YYYY-MM-DD'); // Current week's Sunday
        processDate = today.format('YYYY-MM-DD HH:mm:ss.SSS'); // Current time for current week
      }

      logger.log(`Generating weekly insights for ${startDate} to ${endDate} in ${this.options.stage} environment`);

      const report = await generateDailyReport(
        {
          date: processDate,
          startDate,
          endDate,
        },
        {
          db: { counterLogs: counterLogRepository },
          logger: logger as any,
        }
      );
      if (!report) {
        throw new Error('Failed to generate report - no data returned');
      }

      // Format percentages in the report metrics
      if (report.metrics) {
        for (const [, metric] of Object.entries(report.metrics)) {
          if ('weekOverWeekChange' in metric) {
            metric.weekOverWeekChange = Number(metric.weekOverWeekChange.toFixed(2));
          }
          if ('monthOverMonthChange' in metric) {
            metric.monthOverMonthChange = Number(metric.monthOverMonthChange.toFixed(2));
          }
        }
      }

      logger.log('Generated report from database:', report);

      let aiInsights = null;
      try {
        aiInsights = await generateAIInsights(report, this.options.apiKey, true); // true for weekly report
        logger.log('Generated AI insights:', aiInsights);
      } catch (error) {
        logger.error('Failed to generate AI insights:', error);
        // Don't throw here - AI insights are optional
      }

      const messageData = {
        weekStart: startDate,
        weekEnd: endDate,
        metrics: report.metrics || {},
        userActivity: report.userActivity || {
          totalUniqueUsers: 0,
          internalUsers: 0,
          externalUsers: 0,
          topUsers: [],
          topModels: [],
        },
        aiInsights,
        peakDay: report['peakDay'] ? JSON.parse(JSON.stringify(report['peakDay'])) : undefined,
        peakTime: report['peakTime'] ? JSON.parse(JSON.stringify(report['peakTime'])) : undefined,
        lastWeekPeakDay: report['lastWeekPeakDay'] ? JSON.parse(JSON.stringify(report['lastWeekPeakDay'])) : undefined,
        lastWeekPeakTime: report['lastWeekPeakTime']
          ? JSON.parse(JSON.stringify(report['lastWeekPeakTime']))
          : undefined,
        topOrganizations: report.topOrganizations,
      };

      const message = formatWeeklySlackMessage(process.env.APP_NAME || '', messageData);

      console.log(`\n=== Weekly Report for ${startDate} to ${endDate} ===\n`);
      console.log(message);

      try {
        // Reconnect to read the webhook setting from admin settings.
        await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);

        const slackWebhookUrl = await getSlackWebhookUrl();

        if (slackWebhookUrl) {
          try {
            const response = await fetch(slackWebhookUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ text: message }),
            });

            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            logger.log('Weekly Slack report sent successfully');
            return { status: 'success', weekEnd: endDate };
          } catch (error) {
            logger.error('Failed to send Slack message:', error);
            throw error;
          }
        } else {
          const msg = 'SlackWebhookUrl not configured in admin settings or config';
          logger.error(msg);
          throw new Error(msg);
        }
      } catch (settingsError) {
        logger.error('Error getting Slack webhook URL from settings:', settingsError);
        throw settingsError;
      }

      return 0;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const stackTrace = error instanceof Error ? error.stack : 'No stack trace';
      logger.error('Error in weekly user activity report:', { error: errorMessage, stack: stackTrace });
      throw error;
    }
  }
}

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('Error: API_KEY environment variable is required');
  process.exit(1);
}

const generator = new WeeklyInsightsGenerator({
  date: process.env.DATE,
  stage: Resource.App.stage,
  apiKey: process.env.API_KEY || '',
});

generator
  .run()
  .then(() => {
    console.log('Weekly insights generation completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Failed to generate insights:', error);
    process.exit(1);
  });
