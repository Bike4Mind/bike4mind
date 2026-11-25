/**
 * POST /api/v1/completion-runs - mint a run id for grouping completion spend (createCompletionRunContract).
 *
 * The run is bound to the caller and to the billing owner the completions route would charge
 * (server/chatCompletion/external/sseRoute.ts verifies both before honouring `run`); both resolve
 * the payer through resolveCompletionBillingOrgId and the owner through completionRunOwnerOf.
 */
import { createCompletionRunContract } from '@bike4mind/common';
import { assertEvaluationAuthorized, initialEvaluation } from '@server/completionRuns/evaluation';
import { completionRunRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  completionRunOwnerOf,
  resolveCompletionRunCaller,
  toCompletionRunBody,
} from '@server/completionRuns/callerCompletionRun';

export default nextRouteForContract(createCompletionRunContract, {
  rateLimit: perUserRateLimit('POST /api/v1/completion-runs'),
}).post(async (req, res) => {
  if (req.validated.evaluation) await assertEvaluationAuthorized(req.user.id);
  const caller = await resolveCompletionRunCaller(
    { userId: req.user.id, apiKeyInfo: req.apiKeyInfo },
    req.validated.organization_id
  );
  const run = await completionRunRepository.create({
    userId: req.user.id,
    ...completionRunOwnerOf(caller),
    apiKeyId: req.apiKeyInfo?.keyId,
    rootSessionId: req.validated.rootSessionId,
    budgetCredits: req.validated.budgetCredits,
    ...(req.validated.evaluation && { evaluation: initialEvaluation(req.validated.evaluation) }),
  });

  return res.status(201).json(toCompletionRunBody(run));
});

export const config = {
  api: { externalResolver: true },
};
