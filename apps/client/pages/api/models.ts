/**
 * GET /api/models - the full internal `ModelInfo` list the SPA and CLI read.
 *
 * Unversioned and unpublished; integrators get the public projection at GET /api/v1/models
 * (pages/api/v1/models.ts). Both read getCallerModelList, so they list the same models;
 * v1 additionally drops disabled ones. Only this route serves `lockedModels`, the paid-only
 * models the SPA picker shows a free account as upgradable; clients that ignore it never see them.
 */

import { baseApi } from '@server/middlewares/baseApi';
import { getCallerModelList } from '@server/utils/callerModelList';

const handler = baseApi().get(async (req, res) => {
  const payload = await getCallerModelList(req.user ?? null, req.logger);
  return res.status(200).json(payload);
});

export default handler;
