/**
 * GET /api/v1/completion-runs/{runId}/usage - a run's settled spend (getCompletionRunUsageContract).
 *
 * Readable by the credential that could attribute completions to the run (findCallerCompletionRun),
 * and summed from the ledger rows of the run's billing owner only.
 */
import { getCompletionRunUsageContract, type CompletionRunUsage } from '@bike4mind/common';
import { creditTransactionRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { findCallerCompletionRun } from '@server/completionRuns/callerCompletionRun';

export default nextRouteForContract(getCompletionRunUsageContract, {
  rateLimit: perUserRateLimit('GET /api/v1/completion-runs/[runId]/usage'),
}).get(async (req, res) => {
  const run = await findCallerCompletionRun(req.validatedParams.runId, {
    userId: req.user.id,
    billingOrganizationId: req.apiKeyInfo?.organizationId,
  });
  const spend = await creditTransactionRepository.completionRunSpend(run.runId, {
    ownerId: run.ownerId,
    ownerType: run.ownerType,
  });

  const body: CompletionRunUsage = {
    runId: run.runId,
    ...(run.rootSessionId !== undefined && { rootSessionId: run.rootSessionId }),
    createdAt: run.createdAt.toISOString(),
    ...spend,
  };
  return res.status(200).json(body);
});

export const config = {
  api: { externalResolver: true },
};
