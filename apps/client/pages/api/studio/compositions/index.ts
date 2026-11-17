/**
 * POST /api/studio/compositions - create a Studio Production owned by the caller; 201 with it.
 * GET  /api/studio/compositions - the caller's compositions as summaries (no shots or timeline), newest edit first.
 *
 * Studio only: a signed-in session (no API key) behind the EnableStudioProductions flag and its audience (admins,
 * or paid plans: StudioProductionsAudience), so there is no public contract. The body is the
 * StudioCompositionCreateInputSchema shape; a request that parses but breaks a spec rule (timeline overlap, an
 * unreadable file, a project that is not yours) answers 422 with every issue.
 */
import { z } from 'zod';
import {
  STUDIO_COMPOSITION_LIMITS,
  StudioCompositionCreateInputSchema,
  StudioCompositionResponseSchema,
  StudioCompositionSummaryResponseSchema,
} from '@bike4mind/common';
import { studioCompositionService } from '@bike4mind/services';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { studioCompositionAdapters } from '@server/studio/studioCompositionAdapters';
import { respond } from '@server/utils/respond';

const CreateResponseSchema = z.object({ composition: StudioCompositionResponseSchema });
const ListResponseSchema = z.object({ data: z.array(StudioCompositionSummaryResponseSchema) });

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(STUDIO_COMPOSITION_LIMITS.listLimitMax).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('productions'))
  .use(csrfProtection())
  .post(
    perUserRateLimit('POST /api/studio/compositions'),
    asyncHandler(async (req, res) => {
      const body = StudioCompositionCreateInputSchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'invalid_request', issues: body.error.issues });
      }
      const composition = await studioCompositionService.createComposition(
        req.user.id,
        studioCompositionAdapters,
        body.data
      );
      return respond(res, CreateResponseSchema, { composition }, 201);
    })
  )
  .get(
    perUserRateLimit('GET /api/studio/compositions'),
    asyncHandler(async (req, res) => {
      const query = ListQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(400).json({ error: 'invalid_request', issues: query.error.issues });
      const compositions = await studioCompositionService.listCompositions(
        req.user.id,
        studioCompositionAdapters,
        query.data
      );
      return respond(res, ListResponseSchema, { data: compositions });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
