/**
 * POST /api/v1/completion-runs/{runId}/budget - raise a budgeted run's ceiling (raiseCompletionRunBudgetContract).
 *
 * The explicit step that resumes a run its budget stopped. Same ownership rule as the other run routes
 * (findCallerCompletionRun); a budget is only ever raised (CompletionRunRepository.raiseBudget).
 */
import { ConflictError, RUN_BUDGET_NOT_RAISED_ERROR_CODE, raiseCompletionRunBudgetContract } from '@bike4mind/common';
import { completionRunRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  findCallerCompletionRun,
  resolveCompletionRunCaller,
  toCompletionRunBody,
} from '@server/completionRuns/callerCompletionRun';

export default nextRouteForContract(raiseCompletionRunBudgetContract, {
  rateLimit: perUserRateLimit('POST /api/v1/completion-runs/[runId]/budget'),
}).post(async (req, res) => {
  const run = await findCallerCompletionRun(
    req.validatedParams.runId,
    await resolveCompletionRunCaller({ userId: req.user.id, apiKeyInfo: req.apiKeyInfo }, req.validated.organization_id)
  );
  const outcome = await completionRunRepository.raiseBudget(run.runId, req.validated.budgetCredits);
  if (outcome.kind === 'unbudgeted') {
    throw new ConflictError('This run was created without a budget, so it has none to raise.', {
      errorCode: RUN_BUDGET_NOT_RAISED_ERROR_CODE,
    });
  }
  if (outcome.kind === 'not_higher') {
    throw new ConflictError(
      `A run budget can only be raised: the new budget must be above the current ${outcome.budgetCredits} credits.`,
      { errorCode: RUN_BUDGET_NOT_RAISED_ERROR_CODE }
    );
  }
  return res.status(200).json(toCompletionRunBody(outcome.run));
});

export const config = {
  api: { externalResolver: true },
};
