/**
 * POST /api/v1/decisions - typed questions answered with calibrated probabilities (contract: decisions.contract.ts).
 *
 * A thin HTTP adapter: the contract owns the body, and `runDecision` owns the lifecycle (key lookup,
 * credit hold, input resolution, provider retry, settlement, usage). Only the concerns that exist
 * because this is a route - throttle, body size, status/code mapping, no-store - live here.
 */

import { createDecisionContract } from '@bike4mind/common';
import { sendDecisionError } from '@server/decisions/decisionErrors';
import { runDecision } from '@server/decisions/runDecision';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import { admitRequestCompletion } from '@server/utils/untrustedCompletionQuota';

/**
 * Per-user ceiling, in its own bucket: decision calls are cheap and bursty (routing, triage), so they must not share
 * the chat-tuned per-user budget, and a cap still stops one tenant draining the shared platform vendor key.
 */
const DECISIONS_RATE_LIMIT_PER_MINUTE = 300;

/** Inline data: URL images push bodies past baseApi's 1 MB default; 4 MB stays under Lambda's 6 MB request cap. */
const DECISIONS_MAX_BODY_BYTES = 4 * 1024 * 1024;

const handler = nextRouteForContract(createDecisionContract, {
  maxBodySize: DECISIONS_MAX_BODY_BYTES,
  rateLimit: rateLimit({ limit: DECISIONS_RATE_LIMIT_PER_MINUTE, windowMs: 60_000, bucket: 'POST /api/v1/decisions' }),
}).post(async (req, res) => {
  const quota = await admitRequestCompletion(req, { holdSlot: true });
  try {
    const response = await runDecision({
      caller: {
        userId: req.user.id,
        user: req.user,
        logger: req.logger,
        source: resolveRequestUsageSource(req),
        apiKeyId: req.apiKeyInfo?.keyId,
        apiKeyInfo: req.apiKeyInfo,
      },
      body: req.validated,
    });
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(response);
  } catch (error) {
    if (sendDecisionError(res, error)) return;
    throw error;
  } finally {
    await quota.release();
  }
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
    // Must match DECISIONS_MAX_BODY_BYTES, which baseApi checks first.
    bodyParser: { sizeLimit: '4mb' },
  },
};
