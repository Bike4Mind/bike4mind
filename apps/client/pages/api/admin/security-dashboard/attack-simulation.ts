import { canAccessAdmin } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
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

const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!canAccessAdmin(req.user)) {
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
