import { getCompletionRunEvaluationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { findCallerCompletionRun, resolveCompletionRunCaller } from '@server/completionRuns/callerCompletionRun';
import { refuseExchangeKey } from '@server/auth/refuseExchangeKey';

export default nextRouteForContract(getCompletionRunEvaluationContract, {
  rateLimit: perUserRateLimit('GET /api/v1/completion-runs/[runId]/evaluation'),
}).get(async (req, res) => {
  // Evaluation receipts are for the signed-in desktop app; no connected app needs them.
  if (refuseExchangeKey(req, res)) return;
  const run = await findCallerCompletionRun(
    req.validatedParams.runId,
    await resolveCompletionRunCaller(
      { userId: req.user.id, apiKeyInfo: req.apiKeyInfo },
      req.validatedQuery.organization_id
    )
  );
  if (!run.evaluation) throw new NotFoundError('Evaluation run not found.', { errorCode: 'run_not_found' });
  return res.status(200).json(run.evaluation);
});

export const config = { api: { externalResolver: true } };
