import { FeedbackModel } from '@bike4mind/database';
import { FeedbackRollupQuerySchema, parseFeedbackRollupBound } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import {
  buildFeedbackRollupPipeline,
  toFeedbackRollupResponse,
  type FeedbackRollupFacet,
} from '@server/utils/feedbackRollup';

/**
 * GET /api/feedback/rollup
 *
 * Counts a caller's own feedback reports over a date window. Session-only, and deliberately not
 * a public/api-contract route: no ApiKeyScope covers feedback, so `jwtOnly` is what keeps a
 * key-bearing request from being validated, metered and billed against a route with no scope
 * gate to authorize it.
 *
 * The scope is literally `{ userId }` off the session, NOT the CASL ability: an admin holds an
 * unconditional read grant, so `accessibleBy` narrows to `{}` and would turn a personal rollup
 * into an aggregate over everybody's reports. An admin gets their own rollup here like anyone
 * else; an organization-wide rollup is a separate, separately-authorized route.
 *
 * The aggregate is uncached and heavier than the paged list. It carries no rate-limit option of
 * its own: the window cap in FeedbackRollupQuerySchema and the shared per-dimension top-N are
 * what bound the work a single request can ask for.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  // Explicit rather than inherited: `jwtOnly` already rejects an unauthenticated request, but a
  // rollup that fell through to an undefined scope would aggregate the whole collection.
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // The schema has no `userId` key, so `?userId=<someone-else>` is stripped here rather than
  // reaching the pipeline. Never read the principal off the query on this route.
  const query = FeedbackRollupQuerySchema.parse(req.query);
  const from = parseFeedbackRollupBound(query.from);
  const to = parseFeedbackRollupBound(query.to);

  const [facet] = await FeedbackModel.aggregate<FeedbackRollupFacet>(buildFeedbackRollupPipeline({ userId }, from, to));

  return res.json(toFeedbackRollupResponse(facet, from, to));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
