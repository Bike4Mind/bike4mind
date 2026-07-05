// @vitest-environment node
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope, OverwatchAnalyticsEventSchema, OVERWATCH_ANALYTICS_SCHEMA_VERSION } from '@bike4mind/common';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { sendBatchToQueue } from '@server/utils/sqs';
import { emitMetric, emitMetrics } from '@server/utils/cloudwatch';
import { Config } from '@server/utils/config';
import { z } from 'zod';

const INGEST_NAMESPACE = 'Lumina5/OverwatchIngest';

const SingleEventEnvelope = z.object({ event: OverwatchAnalyticsEventSchema });
const BatchEventEnvelope = z.object({ events: z.array(OverwatchAnalyticsEventSchema).min(1).max(100) });
const EventEnvelope = z.union([SingleEventEnvelope, BatchEventEnvelope]);

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const handler = baseApi({ maxBodySize: 256 * 1024 }).post(async (req, res) => {
  // FIRST check: must be API-key authenticated. Session-auth/CSRF is explicitly rejected.
  if (!req.apiKeyInfo) {
    return res.status(401).json({ error: 'API key required' });
  }

  const productId = req.apiKeyInfo.productId;

  // Kill switch: check before emitting IngestRequest metric (absence-alarm detects silent flips)
  if (Config.OVERWATCH_INGEST_ENABLED?.toLowerCase() === 'false') {
    return res.status(503).json({ error: 'Ingest temporarily disabled' });
  }

  if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE)) {
    return res.status(403).json({ error: 'Insufficient scope' });
  }

  if (!productId) {
    return res.status(403).json({ error: 'Key not bound to a product' });
  }

  const envelopeParse = EventEnvelope.safeParse(req.body);
  if (!envelopeParse.success) {
    return res.status(400).json({ error: 'Invalid request envelope', details: envelopeParse.error.issues });
  }

  const rawEvents = 'event' in envelopeParse.data ? [envelopeParse.data.event] : envelopeParse.data.events;

  const now = Date.now();
  const accepted: number[] = [];
  const results: Array<{ index: number; eventId?: string; status: 'accepted' | 'rejected'; error?: string }> = [];

  for (let i = 0; i < rawEvents.length; i++) {
    const event = rawEvents[i];

    const parsed = OverwatchAnalyticsEventSchema.safeParse(event);
    if (!parsed.success) {
      results.push({ index: i, status: 'rejected', error: parsed.error.issues[0]?.message ?? 'Invalid event' });
      continue;
    }

    if (parsed.data.productId !== productId) {
      results.push({ index: i, status: 'rejected', error: 'productId mismatch' });
      continue;
    }

    if (parsed.data.schemaVersion > OVERWATCH_ANALYTICS_SCHEMA_VERSION) {
      results.push({
        index: i,
        status: 'rejected',
        error: `schemaVersion ${parsed.data.schemaVersion} not supported; current is ${OVERWATCH_ANALYTICS_SCHEMA_VERSION}`,
      });
      continue;
    }

    const eventTs = new Date(parsed.data.timestamp).getTime();
    if (isNaN(eventTs) || eventTs < now - TWENTY_FOUR_HOURS_MS || eventTs > now + FIVE_MINUTES_MS) {
      results.push({ index: i, status: 'rejected', error: 'timestamp outside accepted window [now-24h, now+5min]' });
      continue;
    }

    accepted.push(i);
  }

  // Fire-and-forget: per-product metric for per-product alarms + dimensionless total for the
  // global absence-alarm (overwatchIngestSilent in alarms.ts). The global alarm watches
  // IngestRequestTotal (no dimensions) - emitting only IngestRequest{productId} would leave
  // the dimensionless series empty, keeping the alarm stuck in ALARM permanently.
  emitMetrics(INGEST_NAMESPACE, [
    { name: 'IngestRequest', value: 1, dimensions: { productId }, unit: StandardUnit.Count },
    { name: 'IngestRequestTotal', value: 1, unit: StandardUnit.Count },
  ]).catch(() => {});

  // Emit per-product IngestError{productId} + dimensionless IngestErrorTotal in one call.
  // The overwatchIngestErrors alarm (alarms.ts) watches IngestErrorTotal (no dimensions) - emitting
  // only IngestError{productId} leaves the dimensionless series empty so the alarm can never fire.
  // Mirrors the IngestRequest/IngestRequestTotal pattern above.
  const emitIngestError = (count: number) =>
    emitMetrics(INGEST_NAMESPACE, [
      { name: 'IngestError', value: count, dimensions: { productId }, unit: StandardUnit.Count },
      { name: 'IngestErrorTotal', value: count, unit: StandardUnit.Count },
    ]).catch(() => {});

  if (accepted.length === 0) {
    return res.status(400).json({
      accepted: 0,
      rejected: results.length,
      results: results.sort((a, b) => a.index - b.index),
    });
  }

  const acceptedEvents = accepted.map(i => rawEvents[i] as Record<string, unknown>);
  const startMs = Date.now();

  try {
    const queueUrl = getSourceQueueUrl('overwatchAnalyticsQueue');
    const batchResults = await sendBatchToQueue(queueUrl, acceptedEvents);

    const failedInBatch = batchResults.filter(r => !r.success);
    const succeededInBatch = batchResults.filter(r => r.success);

    // Map batch results back to original indices
    for (let bi = 0; bi < batchResults.length; bi++) {
      const br = batchResults[bi];
      const originalIndex = accepted[br.index];
      const event = rawEvents[originalIndex];
      if (br.success) {
        results.push({ index: originalIndex, eventId: (event as { eventId?: string }).eventId, status: 'accepted' });
      } else {
        results.push({ index: originalIndex, status: 'rejected', error: `Queue error: ${br.error}` });
      }
    }

    const latencyMs = Date.now() - startMs;
    req.logger?.info('overwatch.ingest', { productId, eventCount: succeededInBatch.length, latencyMs });
    emitMetric(INGEST_NAMESPACE, 'IngestLatency', latencyMs, { productId }, StandardUnit.Milliseconds).catch(() => {});

    if (failedInBatch.length > 0) {
      emitIngestError(failedInBatch.length);
    }

    const finalAccepted = results.filter(r => r.status === 'accepted').length;
    const finalRejected = results.filter(r => r.status === 'rejected').length;

    if (finalAccepted === 0) {
      emitIngestError(1);
      return res
        .status(500)
        .json({ accepted: 0, rejected: finalRejected, results: results.sort((a, b) => a.index - b.index) });
    }

    return res
      .status(200)
      .json({ accepted: finalAccepted, rejected: finalRejected, results: results.sort((a, b) => a.index - b.index) });
  } catch (err) {
    req.logger?.error('overwatch.ingest.error', { productId, error: err });
    emitIngestError(1);
    return res.status(500).json({ error: 'Failed to queue events' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
