import { createHash, randomUUID } from 'node:crypto';
import { BusinessMetricState } from '@bike4mind/database';
import {
  DAY_MS,
  HOUR_MS,
  type BusinessMetricAnomaly,
  type ComparisonWindow,
  type Metric,
} from '@bike4mind/server-utils/analytics/businessMetricAnomalies';
import {
  formatBusinessMetricSlackMessage,
  type BusinessMetricMessageOptions,
  type BusinessMetricSlackMessage,
} from '@bike4mind/server-utils/analytics/businessMetricSlackMessage';

export async function subscriberMetric(window: ComparisonWindow, subscribers: number): Promise<Metric> {
  const id = `subscribers:${window.end.toISOString()}`;
  const now = new Date();
  // A late replay cannot masquerade as a historical subscription sample.
  if (now.getTime() - window.end.getTime() < HOUR_MS) {
    await BusinessMetricState.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          subscribers,
          sampledAt: now,
          expiresAt: new Date(window.end.getTime() + 10 * DAY_MS),
        },
      },
      { upsert: true }
    );
  }
  const ids = Array.from(
    { length: 8 },
    (_, index) => `subscribers:${new Date(window.end.getTime() - index * DAY_MS).toISOString()}`
  );
  const samples = await BusinessMetricState.find({ _id: { $in: ids } }).lean();
  const byId = new Map(samples.map(sample => [sample._id, sample.subscribers]));
  return { name: 'payingSubscribers', values: ids.map(key => byId.get(key) ?? null), contributors: [] };
}

export type DeliveryStore = {
  claim: (id: string, token: string, now: Date) => Promise<boolean>;
  complete: (id: string, token: string, now: Date) => Promise<void>;
  release: (id: string, token: string) => Promise<void>;
};

// Lease tokens ensure a timed-out owner cannot release or complete a newer invocation's claim.
export const deliveryStore: DeliveryStore = {
  async claim(id, token, now) {
    await BusinessMetricState.updateOne(
      { _id: id },
      { $setOnInsert: { expiresAt: new Date(now.getTime() + 10 * DAY_MS) } },
      { upsert: true }
    );
    const result = await BusinessMetricState.updateOne(
      { _id: id, deliveredAt: null, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
      {
        $set: { leaseUntil: new Date(now.getTime() + 15 * 60_000), leaseToken: token },
      }
    );
    return result.modifiedCount === 1;
  },
  async complete(id, token, now) {
    const result = await BusinessMetricState.updateOne(
      { _id: id, leaseToken: token },
      { $set: { deliveredAt: now }, $unset: { leaseUntil: '', leaseToken: '' } }
    );
    if (result.modifiedCount !== 1) throw new Error('Business metric delivery lease lost');
  },
  async release(id, token) {
    await BusinessMetricState.updateOne({ _id: id, leaseToken: token }, { $unset: { leaseUntil: '', leaseToken: '' } });
  },
};

/**
 * Posts one message grouping every anomaly whose receipt this invocation could claim. Receipts
 * stay per metric, day and direction, so a metric already announced this UTC day drops out of
 * the group while the others still post; a run that claims nothing posts nothing.
 */
export async function deliverAnomalies(
  window: ComparisonWindow,
  anomalies: BusinessMetricAnomaly[],
  post: (message: BusinessMetricSlackMessage) => Promise<boolean>,
  store: DeliveryStore = deliveryStore,
  options: BusinessMetricMessageOptions = {}
) {
  // The midnight close has its own receipt so an early intraday alert cannot suppress it.
  const day = new Date(window.end.getTime() - (window.mode === 'daily' ? 1 : 0)).toISOString().slice(0, 10);
  const claimed: Array<{ anomaly: BusinessMetricAnomaly; id: string; token: string }> = [];
  for (const anomaly of anomalies) {
    const metricHash = createHash('sha256').update(anomaly.metricName).digest('hex');
    // Keep existing intraday keys valid across deployment; only daily closes use a new namespace.
    const id = `alert:${day}:${anomaly.direction}:${window.mode === 'daily' ? 'daily:' : ''}${metricHash}`;
    const token = randomUUID();
    if (await store.claim(id, token, new Date())) claimed.push({ anomaly, id, token });
  }
  if (claimed.length === 0) return 0;
  try {
    const posted = await post(
      formatBusinessMetricSlackMessage(
        window,
        claimed.map(({ anomaly }) => anomaly),
        options
      )
    );
    if (!posted) throw new Error('Slack rejected business metric alert');
  } catch (error) {
    await Promise.allSettled(claimed.map(({ id, token }) => store.release(id, token)));
    throw error;
  }
  // The alert is already in Slack: keep the leases so a retry cannot post it twice, and complete
  // every receipt even when one fails so the others cannot be re-claimed and re-posted.
  const results = await Promise.allSettled(
    claimed.map(({ id, token }) =>
      store.complete(id, token, new Date()).catch(() => store.complete(id, token, new Date()))
    )
  );
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return claimed.length;
}
