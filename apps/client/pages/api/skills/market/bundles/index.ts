// apps/client/pages/api/skills/market/bundles/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { bundleOwnerFrom, createBundle, listBundles } from '@server/skillMarket/bundles';

/**
 * GET /api/skills/market/bundles?orgId= or ?spaceId= - an org's or Space's Claude Code skill bundles and the listings they may hold.
 * POST /api/skills/market/bundles - create one (org admins, Space owners and admins). See server/skillMarket/bundles.ts.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const { orgId, spaceId } = req.query;
    const owner = bundleOwnerFrom({ organizationId: orgId, spaceId });
    res.json(await listBundles({ id: req.user!.id, isAdmin: req.user!.isAdmin }, owner));
  })
  .post(async (req, res) => {
    res.status(201).json(await createBundle({ id: req.user!.id, isAdmin: req.user!.isAdmin }, req.body));
  });

export default handler;
