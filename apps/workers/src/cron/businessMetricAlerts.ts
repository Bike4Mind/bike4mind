import { adminSettingsRepository, connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  anomalyAlerts,
  comparisonWindow,
  thresholdsSchema,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { getSettingsMap, getSettingsValue, postMessageToSlack } from '@bike4mind/utils';
import { Resource } from 'sst';
import { z } from 'zod';
import {
  appUrlFromEnv,
  isProductionStage,
  resolveAlarmWebhookUrl,
  SECRET_PLACEHOLDER,
  stageLabel,
} from '../events/alarmSlackMessage';
import { collectBusinessMetrics } from './businessMetrics/collect';
import { deliverAnomalies, subscriberMetric } from './businessMetrics/deliver';
import { Logger } from '@bike4mind/observability';

const eventSchema = z.object({ time: z.iso.datetime().optional() });

export async function handler(event: unknown) {
  if (!['production', 'dev'].includes(Resource.App.stage)) return { status: 'skipped' };
  const input = eventSchema.parse(event);
  const window = comparisonWindow(input.time ? new Date(input.time) : new Date());
  const thresholds = thresholdsSchema.parse(JSON.parse(process.env.BUSINESS_METRIC_THRESHOLDS || '{}'));
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  const webhook = await reportWebhook(Resource.App.stage);
  if (!webhook) {
    Logger.info('business metric alerts skipped', {
      report: 'business-metric-alerts',
      status: 'skipped',
      reason: 'missing-webhook',
      setting: isProductionStage(Resource.App.stage) ? 'SlackUserActivityWebhookUrl' : 'SLACK_ALARMS_WEBHOOK_URL',
    });
    return { status: 'skipped', reason: 'missing-webhook' };
  }
  const result = await collectBusinessMetrics(window);
  const subscribers = await subscriberMetric(window, result.subscribers);
  const metrics = [...result.metrics, subscribers];
  const anomalies = anomalyAlerts(metrics, thresholds);
  const delivered = await deliverAnomalies(
    window,
    anomalies,
    message => postMessageToSlack(webhook, message),
    undefined,
    { appUrl: appUrlFromEnv(), stage: stageLabel(Resource.App.stage) }
  );
  Logger.info('business metric alerts report', {
    report: 'business-metric-alerts',
    end: window.end.toISOString(),
    mode: window.mode,
    metrics: metrics.length,
    anomalies: anomalies.length,
    delivered,
    subscriberBaselineReady: subscribers.values[1] !== null,
  });
  return { status: 'success', anomalies: anomalies.length, delivered };
}

/**
 * Production posts to the user-activity channel its admins configured. Staging's numbers are
 * test traffic, so it posts to the stage's alarms channel instead of whatever its own copy of
 * that admin setting points at, which has been a team-wide channel.
 */
async function reportWebhook(stage: string): Promise<string> {
  if (!isProductionStage(stage)) {
    const url = resolveAlarmWebhookUrl(Resource).trim();
    return url === SECRET_PLACEHOLDER ? '' : url;
  }
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['SlackUserActivityWebhookUrl'] }
  );
  return getSettingsValue('SlackUserActivityWebhookUrl', settings, '').trim();
}
