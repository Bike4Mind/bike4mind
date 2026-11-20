/**
 * POST /api/v1/pending-actions/{questId}/deny - decline the tool call an agent is waiting on; nothing runs.
 * JWT only; the acting user is `req.user`, authorized against the quest's session owner.
 */
import { denyPendingActionContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decidePendingAction } from '@server/mcp/decidePendingAction';

const route = nextRouteForContract(denyPendingActionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/pending-actions/[questId]/deny'),
}).post(async (req, res) => {
  const { status, body } = await decidePendingAction({
    user: req.user,
    questId: req.validatedParams.questId,
    pendingActionTs: req.validated.pendingActionTs,
    confirmed: false,
    logger: req.logger,
  });
  return res.status(status).json(body);
});

export const config = {
  api: { externalResolver: true },
};

export default route;
