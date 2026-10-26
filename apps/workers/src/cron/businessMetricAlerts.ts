import { adminSettingsRepository, connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import {
  anomalyMessages,
  comparisonWindow,
  thresholdsSchema,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import { getSettingsMap, getSettingsValue, postMessageToSlack } from '@bike4mind/utils';
import { Resource } from 'sst';
import { z } from 'zod';
import { collectBusinessMetrics } from './businessMetrics/collect';
import { deliverAnomalies, subscriberMetric } from './businessMetrics/deliver';

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
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: ['SlackUserActivityWebhookUrl'] }
  );
  const webhook = getSettingsValue('SlackUserActivityWebhookUrl', settings, '').trim();
  if (!webhook) throw new Error('Configure SlackUserActivityWebhookUrl for business metric alerts');
  const result = await collectBusinessMetrics(window);
  const subscribers = await subscriberMetric(window, result.subscribers);
  subscribers.contributors = result.subscriberContributors;
  const metrics = [...result.metrics, subscribers];
  const messages = anomalyMessages(metrics, window, thresholds);
  const delivered = await deliverAnomalies(window, messages, message => postMessageToSlack(webhook, message));
  console.info(
    JSON.stringify({
      report: 'business-metric-alerts',
      end: window.end.toISOString(),
      mode: window.mode,
      metrics: metrics.length,
      anomalies: messages.length,
      delivered,
      subscriberBaselineReady: subscribers.values[1] !== null,
    })
  );
  return { status: 'success', anomalies: messages.length, delivered };
}
