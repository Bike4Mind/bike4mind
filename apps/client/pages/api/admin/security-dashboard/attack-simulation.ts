import { adminApi } from '@server/middlewares/adminApi';
import { Resource } from 'sst';
import { ApiKeyScope } from '@bike4mind/common';
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

const handler = adminApi({
  adminPermissions: { GET: 'support:read' },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
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
