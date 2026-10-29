/**
 * POST /api/v1/text-refinements - rewrites a short description to be clearer and more detailed.
 *
 * Shares refineTextRequest (cache + operations model) with the legacy POST /api/ai/refineText.
 * A cache miss is credit-metered against the caller inside refineTextRequest; a billing refusal
 * (422 insufficient_credits, 400 for a departed org key holder) propagates to errorHandler.
 */

import { createTextRefinementContract } from '@bike4mind/common';
import { getHttpStatus } from '@bike4mind/utils';
import { RefineFailedError, RefineProviderUnavailableError, refineTextRequest } from '@server/ai/refineTextRequest';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { admitRequestCompletion } from '@server/utils/untrustedCompletionQuota';

const handler = nextRouteForContract(createTextRefinementContract).post(async (req, res) => {
  const { text, context } = req.validated;

  const quota = await admitRequestCompletion(req, { holdSlot: true });
  let refined: string | undefined;
  try {
    refined = await refineTextRequest({ text, context }, req);
  } catch (error) {
    if (error instanceof RefineProviderUnavailableError) {
      req.logger.warn('Text refinement provider not configured', error.cause ?? error);
      return res.status(503).json({
        error: 'No operations model is configured on this deployment.',
        errorCode: 'provider_not_configured',
      });
    }
    if (error instanceof RefineFailedError) {
      req.logger.error('Text refinement failed', error.cause ?? error);
      // A refused key is a permanent misconfiguration, not a transient provider fault: retrying
      // it never helps, so it gets the 401 the conventions and sibling endpoints publish.
      const status = error.cause instanceof Error ? getHttpStatus(error.cause) : undefined;
      if (status === 401 || status === 403) {
        return res.status(401).json({
          error: 'The text-refinement provider rejected the configured credential.',
          errorCode: 'provider_rejected',
        });
      }
      return res.status(502).json({ error: 'Text refinement failed' });
    }
    // Anything unclassified - a cache/DB fault, a resolver failure - is an internal error, not a
    // provider one. Rethrow so errorHandler answers the same 500 the legacy route gets.
    throw error;
  } finally {
    await quota.release();
  }

  // Deliberate product decision, not a schema requirement: TextRefinementResponseSchema is
  // `text: z.string()`, which accepts ''. The helper refuses to cache an empty refinement now, so
  // this only catches one cached before that change (the legacy route cached whatever it got).
  if (!refined) {
    return res.status(502).json({ error: 'The model returned no refined text' });
  }
  return res.json({ text: refined });
});

export default handler;
