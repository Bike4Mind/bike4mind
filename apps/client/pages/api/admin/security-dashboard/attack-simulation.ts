import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Resource } from 'sst';
import {
  securityFindingRepository,
  securityFindingRunRepository,
  type ISecurityFindingDocument,
  type ISecurityFindingRunDocument,
} from '@bike4mind/database';

export interface AttackSimulationGetResponse {
  stage: string;
  runs: ISecurityFindingRunDocument[];
  findings: ISecurityFindingDocument[];
}

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const stage = Resource.App.stage;

  const [runs, findings] = await Promise.all([
    securityFindingRunRepository.findRecentByStage(stage, 10),
    securityFindingRepository.findActiveByStage(stage),
  ]);

  const response: AttackSimulationGetResponse = { stage, runs, findings };
  return res.status(200).json(response);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
