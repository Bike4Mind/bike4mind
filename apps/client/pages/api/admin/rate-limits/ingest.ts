import { baseApi } from '@server/middlewares/baseApi';
import { persistRateLimitEvents } from '@bike4mind/server-utils/utils/mcpRateLimitSnapshots';
import { Resource } from 'sst';
import { safeCompareTokens } from '@bike4mind/auth/crypto';
import type { Request } from 'express';
import { z } from 'zod';

// tenantKey comes from the MCP handler Lambda (resolveMcpTenantKey); the ingest token is what
// makes it trustworthy. Events are validated one by one in persistRateLimitEvents.
const IngestBodySchema = z.object({
  events: z.array(z.unknown()).min(1),
  tenantKey: z.string().min(1).max(64),
});

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

  const parsed = IngestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'events array and tenantKey required' });
  }

  const { events, tenantKey } = parsed.data;
  const persisted = await persistRateLimitEvents(events, tenantKey);

  return res.json({ persisted });
});

export default handler;
