import {
  FeedbackModel,
  buildFeedbackRollupPipeline,
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  toFeedbackRollupResponse,
  type FeedbackRollupFacet,
} from '@bike4mind/database';
import { FeedbackRollupQuerySchema, parseFeedbackRollupBound } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';

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
 * accumulated the whole matched set, so it never bounds the work a request can ask for. This
 * route carries no rate-limit option of its own (no JWT-path limiter exists), so `maxTimeMS`
 * below is the actual per-request work bound.
 */
// Same value/shape as apps/client/pages/api/users/counterLogs.ts's own aggregate timeout.
const FEEDBACK_ROLLUP_MAX_TIME_MS = 45000;

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
