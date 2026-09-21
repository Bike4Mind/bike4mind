import { FeedbackModel, convertPipelineForDocumentDB, executeFacetCompatible } from '@bike4mind/database';
import { FeedbackRollupQuerySchema, parseFeedbackRollupBound } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
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
 * The aggregate is uncached and heavier than the paged list. The window cap in
 * FeedbackRollupQuerySchema and the shared per-dimension top-N bound the MATCHED set and the
 * RESPONSE size respectively - top-N is applied per arm only after $group has already
 * accumulated the whole matched set, so it never bounds the work a request can ask for. Two
 * separate bounds cover that: `rateLimit` below caps how many of these one caller can ask for per
 * window (chained after baseApi's auth, so it keys on `req.user.id` rather than the client IP),
 * and `maxTimeMS` bounds the work of any one request. Nothing decrements the limiter's counter on
 * response, so it bounds requests per window, not aggregates in flight at the same instant.
 */
// Same value/shape as apps/client/pages/api/users/counterLogs.ts's own aggregate timeout.
const FEEDBACK_ROLLUP_MAX_TIME_MS = 45000;

const ONE_MINUTE_MS = 60 * 1000;
// Same 10/min as the org-wide $facet report next door: narrower scope, but the same shape of read,
// and this pipeline adds a per-document $lookup ahead of $facet. The interactive date-window picker
// is the only caller and it refetches on a window change, not on a timer (the query sets no
// refetchInterval and the app's QueryClient disables retry and focus/reconnect refetch).
const FEEDBACK_ROLLUP_RATE_LIMIT = 10;

const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: FEEDBACK_ROLLUP_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'feedback-rollup' }))
  .get(async (req, res) => {
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

    const { pipeline, facetStages } = buildFeedbackRollupPipeline({ userId }, from, to);
    const [facet] = (await executeFacetCompatible(FeedbackModel, convertPipelineForDocumentDB(pipeline), facetStages, {
      maxTimeMS: FEEDBACK_ROLLUP_MAX_TIME_MS,
    })) as FeedbackRollupFacet[];

    // A per-principal aggregate: never a shared cache entry, and never stored by an intermediary.
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(toFeedbackRollupResponse(facet, from, to));
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
