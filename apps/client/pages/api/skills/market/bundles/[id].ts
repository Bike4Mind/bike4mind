// apps/client/pages/api/skills/market/bundles/[id].ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { deleteBundle, updateBundle } from '@server/skillMarket/bundles';

/** PUT / DELETE /api/skills/market/bundles/[id] - edit or remove an org's skill bundle (org admins). */
const handler = baseApi({ auth: 'jwtOnly' })
  .put<Request<{}, {}, unknown, { id: string }>>(async (req, res) => {
    res.json(await updateBundle({ id: req.user!.id, isAdmin: req.user!.isAdmin }, req.query.id, req.body));
  })
  .delete<Request<{}, {}, {}, { id: string }>>(async (req, res) => {
    await deleteBundle({ id: req.user!.id, isAdmin: req.user!.isAdmin }, req.query.id);
    res.status(204).end();
  });

export default handler;
