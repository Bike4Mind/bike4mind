// apps/client/pages/api/skills/market/bundles/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { BadRequestError } from '@bike4mind/common';
import { createBundle, listBundles } from '@server/skillMarket/bundles';

/**
 * GET /api/skills/market/bundles?orgId= - an org's Claude Code skill bundles and the listings they may hold.
 * POST /api/skills/market/bundles - create one (org admins). See server/skillMarket/bundles.ts.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const { orgId } = req.query;
    if (typeof orgId !== 'string' || !orgId) throw new BadRequestError('orgId is required');
    res.json(await listBundles({ id: req.user!.id, isAdmin: req.user!.isAdmin }, orgId));
  })
  .post(async (req, res) => {
    res.status(201).json(await createBundle({ id: req.user!.id, isAdmin: req.user!.isAdmin }, req.body));
  });

export default handler;
