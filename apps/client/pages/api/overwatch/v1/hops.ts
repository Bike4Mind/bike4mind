import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ApiKeyScope } from '@bike4mind/common';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendBatchToQueue } from '@bike4mind/server-utils/utils/sqs';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';
import { INGEST_FAILURE_METRIC } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { Config } from '@bike4mind/server-utils/utils/config';
import { HopMintBodySchema, hopMintedEvent, mintHop } from '@server/analytics/hops';

/**
 * POST /api/overwatch/v1/hops - mint a verified hop.
 *
 * Called by a source product's server, from its own `/out/<dest>` endpoint, when a visitor clicks
 * through to a destination: never from a browser. Authenticated by the source product's Overwatch
 * ingest key, the same key and checks as POST /api/overwatch/v1/events (versioned alongside it).
 * The hop's source is the product that key is bound to; the body cannot name one.
 *
 * Body: `{ dest, path?, srcSessionId?, srcVisitorHash?, lane? }`. Without the visitor's consent
 * the source sends neither srcSessionId nor srcVisitorHash, and the hop is still minted.
 *
 * 201 `{ hopId, token, expiresAt, url? }`. The source redirects the browser straight to `url`
 * (`<app><path>?b4m_hop=<token>`). The token redeems once, within 10 minutes. It must never be
 * rendered into a page or logged, here or by the source.
 */

// Per key, and separate from the key's own request quota, which it shares with event ingest. A
// source mints one hop per click, so 120 a minute is far above real use; it bounds how fast one
// key can fill the hop store.
const HOP_MINT_RATE_LIMIT = {
  limit: 120,
  windowMs: 60 * 1000,
  bucket: 'overwatch-hops-mint',
  subject: (req: { apiKeyInfo?: { keyId?: string } }) => req.apiKeyInfo?.keyId,
} as const;

// `requiredScopes` must stay in sync with the in-handler scope check below, as in events.ts: the
// gate is what lets an ingest key (a confined key) reach this route at all, and the in-handler
// check gives the route its own error shape. overwatchIngestScopeLockstep.test.ts holds both.
const handler = baseApi({
  maxBodySize: 4 * 1024,
  requiredScopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE],
  allowedMethods: ['POST'],
})
  .use(rateLimit(HOP_MINT_RATE_LIMIT))
  .post(async (req, res) => {
    // The response carries a bearer token: never let a cache keep it.
    res.setHeader('Cache-Control', 'no-store');

    // FIRST check: must be API-key authenticated. Session-auth/CSRF is explicitly rejected.
    if (!req.apiKeyInfo) {
      return res.status(401).json({ error: 'API key required' });
    }

    const productId = req.apiKeyInfo.productId;

    // The ingest kill switch covers minting too: a hop is an ingest write.
    if (Config.OVERWATCH_INGEST_ENABLED?.toLowerCase() === 'false') {
      return res.status(503).json({ error: 'Ingest temporarily disabled' });
    }

    if (!req.apiKeyInfo.scopes.includes(ApiKeyScope.OVERWATCH_INGEST_WRITE)) {
      return res.status(403).json({ error: 'Insufficient scope' });
    }

    if (!productId) {
      return res.status(403).json({ error: 'Key not bound to a product' });
    }

    const parsed = HopMintBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid hop request', details: parsed.error.issues });
    }

    if (parsed.data.dest === productId) {
      return res.status(400).json({ error: 'A product cannot hop to itself' });
    }

    const minted = await mintHop({ ...parsed.data, srcProductId: productId });
    if (!minted) {
      return res.status(503).json({ error: 'Hops are not configured' });
    }
    const { hop } = minted;

    // Awaited, since the Lambda can freeze once the response is sent. A failure does not fail the
    // mint: the hop is stored and its token works, and the store is what a redeem checks. It is
    // counted on the same metric as other lost Overwatch emits, so an outage is not silent.
    let queued = false;
    try {
      const [result] = await sendBatchToQueue(getSourceQueueUrl('overwatchAnalyticsQueue'), [hopMintedEvent(hop)]);
      queued = result?.success === true;
    } catch {
      queued = false;
    }
    if (!queued) {
      req.logger?.warn('overwatch.hops.minted_event_failed', { productId, hopId: hop.hopId });
      await emitMetric(INGEST_FAILURE_METRIC.namespace, INGEST_FAILURE_METRIC.name, 1, { Stage: Config.STAGE }).catch(
        () => {}
      );
    }

    req.logger?.info('overwatch.hops.minted', { productId, dest: hop.dest, hopId: hop.hopId });
    return res.status(201).json({
      hopId: hop.hopId,
      token: minted.token,
      expiresAt: minted.expiresAt.toISOString(),
      ...(minted.url !== undefined && { url: minted.url }),
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
