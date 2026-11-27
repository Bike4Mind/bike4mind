import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { SAVED_VIEWS_RATE_LIMIT, savedViewsDeps } from '@server/admin/savedViews/adapters';
import { createSavedView, listSavedViews } from '@server/admin/savedViews/savedViews';
import {
  CreateAdminSavedViewRequestSchema,
  ListAdminSavedViewsQuerySchema,
  type AdminSavedViewResponse,
  type AdminSavedViewsListResponse,
} from '@client/app/utils/adminSavedViews';

/** An admin's saved list views: their own plus every shared one (GET), or a new one (POST). */
const handler = adminApi({
  adminPermissions: { GET: 'support:read', POST: 'settings:manage' },
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .use(rateLimit(SAVED_VIEWS_RATE_LIMIT))
  .get(
    asyncHandler(async (req, res) => {
      const { surface } = parseOrBadRequest(ListAdminSavedViewsQuerySchema, req.query);
      const views = await listSavedViews(req.user.id, surface, savedViewsDeps(req.logger));
      const body: AdminSavedViewsListResponse = { views };
      return res.json(body);
    })
  )
  .post(
    asyncHandler(async (req, res) => {
      const request = parseOrBadRequest(CreateAdminSavedViewRequestSchema, req.body);
      const view: AdminSavedViewResponse = await createSavedView(req.user.id, request, savedViewsDeps(req.logger));
      return res.status(201).json(view);
    })
  );

export default handler;
