/**
 * POST /api/studio/compositions/:id/renders - export the Production: one render job per selected output size, under
 *   one groupId; 202 with the jobs. Credits are held per job and settled on delivery or refunded on failure.
 *   Paid-plan only: a free-tier account gets the paid-model ForbiddenError (admins and developers exempt).
 * GET  /api/studio/compositions/:id/renders - the caller's recent render jobs of this Production, newest first.
 *
 * Studio only, behind the EnableStudioProductions flag, with no public contract. Validation, pricing and billing
 * live in createRenderJobs; the encode runs on the render worker (apps/workers/src/render).
 */
import { z } from 'zod';
import {
  isGenerationJobOfKind,
  StudioCompositionIdSchema,
  StudioRenderCreateInputSchema,
  StudioRenderCreateResponseSchema,
  StudioRenderJobListSchema,
} from '@bike4mind/common';
import { generationJobRepository } from '@bike4mind/database';
import { createRenderJobs } from '@bike4mind/services/renderJobs';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { assertAiAccessAllowed } from '@bike4mind/server-utils/auth/assertAiAccessAllowed';
import { getUserEntitlements, toEntitlementUser } from '@bike4mind/server-utils/entitlements/index';
import { getCreateRenderJobsDeps } from '@bike4mind/server-utils/generationJobs/wiring';
import {
  renderJobRefusalBody,
  toStudioRenderJob,
} from '@bike4mind/server-utils/generationJobs/studioRenderJobResponse';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { resolveMediaBillingOrgId } from '@server/billing/resolveMediaBillingOrgId';
import { respond } from '@server/utils/respond';

const IdQuerySchema = z.object({ id: StudioCompositionIdSchema });
const NOT_FOUND = { error: 'not_found', message: 'Composition not found' };
const RECENT_RENDERS_LIMIT = 100;

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('productions'))
  .use(csrfProtection())
  .post(
    perUserRateLimit('POST /api/studio/compositions/[id]/renders'),
    asyncHandler(async (req, res) => {
      assertAiAccessAllowed(req.user);
      const query = IdQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(404).json(NOT_FOUND);
      const body = StudioRenderCreateInputSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request', issues: body.error.issues });
      // undefined: bill the caller's active organization, as a first-party session does on every media route.
      const organizationId = await resolveMediaBillingOrgId(req, undefined);
      const result = await createRenderJobs(
        {
          user: { id: req.user.id, organizationId, isAdmin: req.user.isAdmin, tags: req.user.tags },
          getEntitlements: () => getUserEntitlements(toEntitlementUser(req.user)),
          compositionId: query.data.id,
          outputIds: body.data.outputIds,
        },
        getCreateRenderJobsDeps()
      );
      if (!result.ok) return res.status(result.status).json(renderJobRefusalBody(result));
      return respond(
        res,
        StudioRenderCreateResponseSchema,
        { groupId: result.groupId, jobs: result.jobs.map(toStudioRenderJob) },
        202
      );
    })
  )
  .get(
    perUserRateLimit('GET /api/studio/compositions/[id]/renders'),
    asyncHandler(async (req, res) => {
      const query = IdQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(404).json(NOT_FOUND);
      const rows = await generationJobRepository.listByRequester({
        requestedBy: req.user.id,
        kind: 'render',
        compositionId: query.data.id,
        limit: RECENT_RENDERS_LIMIT,
      });
      const data = rows.flatMap(job => (isGenerationJobOfKind(job, 'render') ? [toStudioRenderJob(job)] : []));
      return respond(res, StudioRenderJobListSchema, { data });
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
