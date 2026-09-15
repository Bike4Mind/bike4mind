import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import { CounterMetricsResponse, KpiMetrics, UserActivityMetrics } from './types';

export async function generateSlackReport(metricsData: CounterMetricsResponse): Promise<string> {
  const sections: string[] = [];

  sections.push(`*User Activity Summary*
• Total Unique Users: ${metricsData.userActivity.totalUniqueUsers}
• Internal Users: ${metricsData.userActivity.internalUsers}
• External Users: ${metricsData.userActivity.externalUsers}
`);

  sections.push('*Event Metrics Summary*');

  Object.entries(metricsData.metrics).forEach(([eventName, metrics]) => {
    sections.push(`
*${eventName}*
• Last 24h: ${metrics.last24h}
• Weekly: ${metrics.weeklyTotal} (${metrics.weekOverWeekChange}% WoW)
• Monthly: ${metrics.monthlyTotal} (${metrics.monthOverMonthChange}% MoM)
`);
  });

  if (metricsData.userActivity.topUsers.length > 0) {
    sections.push('*Top Users*');
    metricsData.userActivity.topUsers.forEach(user => {
      sections.push(`• ${user.email}: ${user.interactions} interactions`);
    });
  }

  return sections.join('\n');
}

export async function sendSlackReportViaWebhook(
  appName: string,
  data: { metrics: Record<string, KpiMetrics>; userActivity: UserActivityMetrics },
  slackWebhookUrl: string | undefined
): Promise<void> {
  const message = formatSlackMessage(appName, data);

  if (!slackWebhookUrl) {
    Logger.globalInstance.error('sendSlackReportViaWebhook: slackWebhookUrl is not set');
    return;
  }

  try {
    await axios.post(slackWebhookUrl, { text: message });
    Logger.globalInstance.log('Slack report sent successfully');
  } catch (error) {
    Logger.globalInstance.error('Error sending Slack report:', error);
    throw error;
  }
}

export const formatSlackMessage = (
  appName: string,
  data: { metrics: Record<string, KpiMetrics>; userActivity: UserActivityMetrics },
  date?: string
): string => {
  const sections: string[] = [];

  sections.push(`*User Activity Summary*
• Total Unique Users: ${data.userActivity.totalUniqueUsers}
• Internal Users: ${data.userActivity.internalUsers}
• External Users: ${data.userActivity.externalUsers}
`);

  sections.push('*Event Metrics Summary*');

  Object.entries(data.metrics).forEach(([eventName, metrics]) => {
    sections.push(`
*${eventName}*
• Last 24h: ${metrics.last24h}
• Weekly: ${metrics.weeklyTotal} (${metrics.weekOverWeekChange}% WoW)
• Monthly: ${metrics.monthlyTotal} (${metrics.monthOverMonthChange}% MoM)
`);
  });

  if (data.userActivity.topUsers.length > 0) {
    sections.push('*Top Users*');
    data.userActivity.topUsers.forEach(user => {
      sections.push(`• ${user.email}: ${user.interactions} interactions`);
    });
  }

  return sections.join('\n');
};
