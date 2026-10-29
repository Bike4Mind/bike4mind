import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { ForbiddenError, NotFoundError, parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { SAVED_VIEWS_RATE_LIMIT, savedViewsDeps } from '@server/admin/savedViews/adapters';
import { deleteSavedView, updateSavedView } from '@server/admin/savedViews/savedViews';
import { UpdateAdminSavedViewRequestSchema, type AdminSavedViewResponse } from '@client/app/utils/adminSavedViews';

// Not an ObjectId answers 404 like any other missing view (see savedViews.ts on 404 over 403).
const viewIdOf = (query: unknown): string => {
  const id = typeof query === 'object' && query !== null ? (query as { id?: unknown }).id : undefined;
  if (!isValidObjectId(id)) throw new NotFoundError('Saved view not found');
  return id;
};

/** Rename, share/unshare or replace (PATCH), or delete (DELETE) one of the caller's own views. */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit(SAVED_VIEWS_RATE_LIMIT))
  .patch(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const viewId = viewIdOf(req.query);
      const patch = parseOrBadRequest(UpdateAdminSavedViewRequestSchema, req.body);
      const view: AdminSavedViewResponse = await updateSavedView(
        req.user.id,
        viewId,
        patch,
        savedViewsDeps(req.logger)
      );
      return res.json(view);
    })
  )
  .delete(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      await deleteSavedView(req.user.id, viewIdOf(req.query), savedViewsDeps(req.logger));
      return res.status(204).end();
    })
  );

export default handler;
