/** POST /api/v1/skills/market/versions/{vid}/review - the public twin of approve and reject on POST /api/skills/market/versions/[vid]/review. */
import { reviewSkillMarketVersionContract } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { decideVersion } from '@server/skillMarket/submitVersion';
import { toPublicVersion } from '@server/skillMarket/publicView';

const handler = nextRouteForContract(reviewSkillMarketVersionContract).post(async (req, res) => {
  const body = req.validated;
  const actor = { id: req.user.id, isAdmin: req.user.isAdmin };
  const adminOrgIds = await organizationRepository.findIdsAdministeredBy(actor.id);
  const version = await decideVersion(
    req.validatedParams.vid,
    actor,
    adminOrgIds,
    body.action === 'approve'
      ? { action: 'approve', ackHighRisk: body.ack_high_risk, ackMismatch: body.ack_mismatch, note: body.note }
      : { action: 'reject', note: body.note }
  );
  return res.json({ version: toPublicVersion(version, { privileged: true }) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
