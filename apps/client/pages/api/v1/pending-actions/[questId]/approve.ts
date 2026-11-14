/**
 * POST /api/v1/pending-actions/{questId}/approve - approve and run the tool call an agent is waiting on.
 * JWT only; the acting user is `req.user`, authorized against the quest's session owner.
 */
import { approvePendingActionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decidePendingAction } from '@server/mcp/decidePendingAction';

const route = nextRouteForContract(approvePendingActionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/pending-actions/[questId]/approve'),
}).post(async (req, res) => {
  const { status, body } = await decidePendingAction({
    user: req.user,
    questId: req.validatedParams.questId,
    pendingActionTs: req.validated.pendingActionTs,
    confirmed: true,
    logger: req.logger,
  });
  return res.status(status).json(body);
});

export const config = {
  api: { externalResolver: true },
};

export default route;
