#!/usr/bin/env tsx

import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { counterService } from '@bike4mind/services';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import dayjs from 'dayjs';
import { Resource } from 'sst';
import axios from 'axios';

const generateDailyReport = counterService.generateDailyReport;
const generateAIInsights = counterService.generateAIInsights;
const formatCustomSlackMessage = counterService.formatCustomSlackMessage;

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
  functionName: context.functionName,
  functionVersion: context.functionVersion,
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

class DailyInsightsGenerator {
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
    const today = this.options.date || dayjs().format('YYYY-MM-DD');
    logger.log(`Generating insights for ${today} in ${this.options.stage} environment`);

    try {
      await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);

      let report;
      try {
        report = await generateDailyReport(
          { date: today },
          { db: { counterLogs: counterLogRepository }, logger: logger as any }
        );
        logger.log('Generated report from database:', report);
      } catch (dbError) {
        logger.error('Failed to generate report from database:', dbError);
        throw dbError;
      }

      if (!report) {
        throw new Error('Failed to generate report - no data returned');
      }

      let aiInsights = null;

      try {
        aiInsights = await generateAIInsights(report, this.options.apiKey);
        logger.log('Generated AI insights:', aiInsights);
      } catch (error) {
        logger.error('Failed to generate AI insights:', error);
        // Don't throw here - AI insights are optional
      }

      const message = formatCustomSlackMessage(process.env.APP_NAME || '', {
        ...report,
        aiInsights,
        date: today,
      });

      logger.log('Slack message:', message);

      try {
        // Reconnect to read the webhook setting from admin settings.
        await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);

        const slackWebhookUrl = await getSlackWebhookUrl();
        if (!slackWebhookUrl) {
          throw new Error('SlackGeneralWebhookUrl not configured in admin settings or config');
        }

        await axios.post(slackWebhookUrl, { text: message });
        logger.log('Slack report sent successfully');
      } catch (settingsError) {
        logger.error('Error getting Slack webhook URL from settings:', settingsError);
        throw settingsError;
      }

      return 0;
    } catch (error) {
      logger.error('Error in user activity report:', error);
      throw error;
    }
  }
}

const apiKey = process.env.API_KEY;
if (!apiKey) {
  console.error('Error: API_KEY environment variable is required');
  process.exit(1);
}

const generator = new DailyInsightsGenerator({
  date: process.env.DATE,
  stage: Resource.App.stage,
  apiKey,
});

generator
  .run()
  .then(() => {
    console.log('Daily insights generation completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Failed to generate insights:', error);
    process.exit(1);
  });
