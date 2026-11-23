import { getCompletionRunEvaluationContract, NotFoundError } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { findCallerCompletionRun } from '@server/completionRuns/callerCompletionRun';

export default nextRouteForContract(getCompletionRunEvaluationContract, {
  rateLimit: perUserRateLimit('GET /api/v1/completion-runs/[runId]/evaluation'),
}).get(async (req, res) => {
  const run = await findCallerCompletionRun(req.validatedParams.runId, {
    userId: req.user.id,
    billingOrganizationId: req.apiKeyInfo?.organizationId,
  });
  if (!run.evaluation) throw new NotFoundError('Evaluation run not found.', { errorCode: 'run_not_found' });
  return res.status(200).json(run.evaluation);
});

export const config = { api: { externalResolver: true } };
