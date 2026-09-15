import { baseApi } from '@server/middlewares/baseApi';
import { rateLimitSnapshotRepository, type IntegrationType } from '@bike4mind/database';
import { recordRateLimitEvent } from '@server/utils/cloudwatch';
import { normalizeEndpoint, isNearLimit, RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import type { Request } from 'express';

const VALID_INTEGRATIONS = new Set<string>(RATE_LIMIT_INTEGRATIONS);

const handler = baseApi({ auth: false }).post(async (req: Request, res) => {
  const ingestToken = Resource.RATE_LIMIT_INGEST_TOKEN?.value || process.env.RATE_LIMIT_INGEST_TOKEN;
  if (!ingestToken) {
    return res.status(500).json({ error: 'Rate limit ingest token is not configured.' });
  }

  const providedTokenHeader = req.headers['x-rate-limit-ingest-token'];
  const providedToken = Array.isArray(providedTokenHeader) ? providedTokenHeader[0] : providedTokenHeader;
  if (!providedToken || !safeCompareTokens(String(providedToken), ingestToken)) {
    return res.status(403).json({ error: 'Invalid ingest token.' });
  }

  const events = req.body?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array required' });
  }

  let persisted = 0;
  for (const event of events) {
    if (!event.integration || !VALID_INTEGRATIONS.has(event.integration)) continue;

    const usagePercent = event.usagePercent ?? null;
    const limit = event.limit ?? null;
    const remaining = event.remaining ?? null;
    const resetAt = event.resetAt ? new Date(event.resetAt) : null;
    const retryAfterMs = event.retryAfterMs ?? null;
    const wasThrottled = event.type === 'RATE_LIMIT_ERROR';

    try {
      await rateLimitSnapshotRepository.create({
        integration: event.integration as IntegrationType,
        userId: 'system',
        endpoint: event.endpoint || '',
        limit,
        remaining,
        resetAt,
        usagePercent,
        wasThrottled,
        retryAfterMs,
        timestamp: new Date(),
      });
      persisted++;
    } catch (err) {
      console.error('[RateLimit] Ingest: failed to persist event', err);
    }

    if (isNearLimit({ limit, remaining, resetAt, retryAfterMs, usagePercent })) {
      console.warn(
        `[RateLimit] WARNING: ${event.integration} at ${usagePercent}% usage (${remaining}/${limit} remaining)`
      );
    }

    try {
      const normalizedEndpoint = normalizeEndpoint(event.endpoint || '');
      await recordRateLimitEvent(event.integration, usagePercent, wasThrottled, normalizedEndpoint || undefined);
    } catch {
      // CloudWatch failures are non-critical
    }
  }

  return res.json({ persisted });
});

export default handler;
