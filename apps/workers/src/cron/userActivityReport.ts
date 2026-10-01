import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { counterService } from '@bike4mind/services';
import { getSettingsMap } from '@bike4mind/utils';
import { connectDB, counterLogRepository, adminSettingsRepository } from '@bike4mind/database';
import axios from 'axios';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import { getEffectiveApiKeyByBackend, OperationsModelService } from '@client/services/operationsModelService';
import { resolveSlackWebhookUrl } from '@server/integrations/slack/slack';
import { Config } from '@server/utils/config';
import { Resource } from 'sst';

dayjs.extend(isoWeek);

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

interface UserActivityReportEvent {
  reportType?: 'daily' | 'weekly';
}

export async function handler(event: UserActivityReportEvent, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));
  const reportType = event.reportType || 'daily';
  const isWeeklyReport = reportType === 'weekly';

  if (Resource.App.stage !== 'production') {
    logger.log(`Skipping ${reportType} user activity report in non-production environment`);
    return { status: 'skipped', reason: 'non-production environment' };
  }

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    logger.log('Connected to database');

    let reportParams: { date: string; startDate?: string; endDate?: string };
    let displayDate: string;

    if (isWeeklyReport) {
      const today = dayjs();
      const startDate = today.startOf('isoWeek').format('YYYY-MM-DD'); // Monday
      const endDate = today.endOf('isoWeek').format('YYYY-MM-DD'); // Sunday
      const processDate = today.format('YYYY-MM-DD HH:mm:ss.SSS');

      reportParams = { date: processDate, startDate, endDate };
      displayDate = `${startDate} to ${endDate}`;
      logger.log('Generating weekly report for:', displayDate);
    } else {
      const today = dayjs().format('YYYY-MM-DD');
      reportParams = { date: today };
      displayDate = today;
      logger.log('Generating daily report for:', displayDate);
    }

    const report = await counterService.generateDailyReport(reportParams, {
      db: { counterLogs: counterLogRepository },
      logger,
    });

    if (!report) {
      logger.error('Failed to generate report - report is null');
      return { status: 'error', reason: 'report generation failed' };
    }
    logger.log(`Generated ${reportType} report for:`, displayDate);

    let aiInsights = null;
    try {
      const operationsModel = await OperationsModelService.getOperationsModel();
      const apiKey = await getEffectiveApiKeyByBackend('system', operationsModel.modelInfo.backend);

      // A null api key means a Bedrock model, which doesn't need one.
      aiInsights = await counterService.generateAgnosticAiInsights(
        report,
        apiKey || '',
        operationsModel.modelInfo.backend,
        operationsModel.modelInfo.id,
        isWeeklyReport
      );
      logger.log(
        'Generated AI insights using model:',
        operationsModel.modelInfo.id,
        'with backend:',
        operationsModel.modelInfo.backend
      );
    } catch (error) {
      logger.error('Failed to generate AI insights:', error);
      // Non-fatal: continue without AI insights
    }

    let message: string;
    if (isWeeklyReport) {
      message = counterService.formatWeeklySlackMessage(process.env.APP_NAME || '', {
        weekStart: reportParams.startDate!,
        weekEnd: reportParams.endDate!,
        metrics: report.metrics || {},
        userActivity: report.userActivity || {
          totalUniqueUsers: 0,
          internalUsers: 0,
          externalUsers: 0,
          topUsers: [],
          topModels: [],
        },
        aiInsights,
        peakDay: report.peakDay,
        peakTime: report.peakTime,
        lastWeekPeakDay: report.lastWeekPeakDay,
        lastWeekPeakTime: report.lastWeekPeakTime,
        topOrganizations: report.topOrganizations,
        usageBySource: report.usageBySource,
      });
    } else {
      // Use APP_NAME (display brand), matching the weekly path above - NOT Resource.App.name,
      // which is the SST app slug and would leak the internal name into the report.
      message = counterService.formatCustomSlackMessage(process.env.APP_NAME || '', {
        ...report,
        aiInsights,
        date: reportParams.date,
        usageBySource: report.usageBySource,
      });
    }

    // Resolve the Slack webhook URL from admin settings, falling back to config,
    // via the shared cached settings map (connectDB already established above).
    let slackWebhookUrl: string;
    try {
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      slackWebhookUrl = resolveSlackWebhookUrl('SlackGeneralWebhookUrl', settings);
    } catch (error) {
      logger.error('Error fetching Slack webhook settings:', error);
      return { status: 'error', reason: 'Error fetching Slack webhook settings', error: String(error) };
    }

    if (!slackWebhookUrl) {
      logger.error('No SlackGeneralWebhookUrl / SlackDefaultWebhookUrl configured in admin settings or config');
      return { status: 'error', reason: 'Slack webhook not configured' };
    }

    try {
      await axios.post(slackWebhookUrl, { text: message });
      logger.log(`${reportType} Slack report sent successfully`);

      return { status: 'success', reportType, date: displayDate };
    } catch (error) {
      logger.error('Error posting report to Slack:', error);
      return { status: 'error', reason: 'Error posting report to Slack', error: String(error) };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stackTrace = error instanceof Error ? error.stack : 'No stack trace';
    logger.error(`Error in ${reportType} user activity report:`, { error: errorMessage, stack: stackTrace });
    return { status: 'error', reason: errorMessage, stack: stackTrace };
  }
}
