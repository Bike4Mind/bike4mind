/**
 * GET /api/v1/skills/market/bundles/{id}/claude-plugin.zip - an org bundle's approved member skills as
 * one Claude Code plugin archive. The feed (claude-marketplace.json.ts) pins these bytes by sha256.
 */
import mongoose from 'mongoose';
import { getClaudeBundleZipContract, type ISkillBundle } from '@bike4mind/common';
import { SkillBundle } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { NotFoundError } from '@server/utils/errors';
import { memberOrgIdsFor } from '@bike4mind/server-utils/skillMarket/market';
import { bundleZipFor } from '@server/skillMarket/claudeMarketplace';

const handler = nextRouteForContract(getClaudeBundleZipContract).get(async (req, res) => {
  const { id } = req.validatedParams;
  const doc = mongoose.isObjectIdOrHexString(id) ? await SkillBundle.findById(id) : null;
  const bundle = doc?.toJSON() as unknown as ISkillBundle | undefined;
  // 404 for a bundle outside the caller's orgs too, so a bundle's existence isn't confirmed.
  const visible = bundle && (await memberOrgIdsFor(req.user.id)).includes(bundle.organizationId);
  const zip = visible ? await bundleZipFor(bundle) : null;
  if (!zip) throw new NotFoundError('Bundle not found');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).send(zip);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
