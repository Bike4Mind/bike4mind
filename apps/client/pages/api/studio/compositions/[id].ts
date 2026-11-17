/**
 * GET    /api/studio/compositions/:id - one composition the caller owns, with its shots and timeline.
 * PATCH  /api/studio/compositions/:id - replace the given content fields; `projectId: null` unlinks the project.
 * DELETE /api/studio/compositions/:id - delete it. The FabFiles it references are untouched.
 *
 * Owner-only: another user's composition answers 404, the same as a missing one. Studio only, behind the
 * EnableStudioProductions flag and its audience (admins, or paid plans), with no public contract.
 */
import { z } from 'zod';
import {
  StudioCompositionIdSchema,
  StudioCompositionResponseSchema,
  StudioCompositionUpdateInputSchema,
} from '@bike4mind/common';
import { studioCompositionService } from '@bike4mind/services';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { studioCompositionAdapters } from '@server/studio/studioCompositionAdapters';
import { respond } from '@server/utils/respond';

const ItemResponseSchema = z.object({ composition: StudioCompositionResponseSchema });
const IdQuerySchema = z.object({ id: StudioCompositionIdSchema });
const NOT_FOUND = { error: 'not_found', message: 'Composition not found' };

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('productions'))
  .use(csrfProtection())
  .get(
    perUserRateLimit('GET /api/studio/compositions/[id]'),
    asyncHandler(async (req, res) => {
      const query = IdQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(404).json(NOT_FOUND);
      const composition = await studioCompositionService.getComposition(
        req.user.id,
        studioCompositionAdapters,
        query.data.id
      );
      return respond(res, ItemResponseSchema, { composition });
    })
  )
  .patch(
    perUserRateLimit('PATCH /api/studio/compositions/[id]'),
    asyncHandler(async (req, res) => {
      const query = IdQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(404).json(NOT_FOUND);
      const body = StudioCompositionUpdateInputSchema.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: 'invalid_request', issues: body.error.issues });
      const composition = await studioCompositionService.updateComposition(
        req.user.id,
        studioCompositionAdapters,
        query.data.id,
        body.data
      );
      return respond(res, ItemResponseSchema, { composition });
    })
  )
  .delete(
    perUserRateLimit('DELETE /api/studio/compositions/[id]'),
    asyncHandler(async (req, res) => {
      const query = IdQuerySchema.safeParse(req.query);
      if (!query.success) return res.status(404).json(NOT_FOUND);
      await studioCompositionService.deleteComposition(req.user.id, studioCompositionAdapters, query.data.id);
      return res.status(204).end();
    })
  );

export const config = {
  api: { externalResolver: true },
};

export default handler;
