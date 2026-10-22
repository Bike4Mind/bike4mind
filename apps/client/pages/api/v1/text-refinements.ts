/**
 * POST /api/v1/text-refinements - rewrites a short description to be clearer and more detailed.
 *
 * Shares refineTextRequest (cache + operations model) with the legacy POST /api/ai/refineText.
 * Not credit-metered, matching the legacy route; ai:generate plus the per-key rate limit bound the cost.
 */

import { createTextRefinementContract } from '@bike4mind/common';
import { RefineFailedError, RefineProviderUnavailableError, refineTextRequest } from '@server/ai/refineTextRequest';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

const handler = nextRouteForContract(createTextRefinementContract).post(async (req, res) => {
  const { text, context } = req.validated;

  let refined: string | undefined;
  try {
    refined = await refineTextRequest({ text, context }, { logger: req.logger });
  } catch (error) {
    if (error instanceof RefineProviderUnavailableError) {
      return res.status(503).json({
        error: 'No operations model is configured on this deployment.',
        errorCode: 'provider_not_configured',
      });
    }
    if (error instanceof RefineFailedError) {
      req.logger.error('Text refinement failed', error.cause ?? error);
      return res.status(502).json({ error: 'Text refinement failed' });
    }
    // Anything unclassified - a cache/DB fault, a resolver failure - is an internal error, not a
    // provider one. Rethrow so errorHandler answers the same 500 the legacy route gets.
    throw error;
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
