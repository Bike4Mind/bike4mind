/**
 * POST /api/v1/completion-runs - mint a run id for grouping completion spend (createCompletionRunContract).
 *
 * The run is bound to the caller and to the billing owner the completions route would charge
 * (server/chatCompletion/external/sseRoute.ts verifies both before honouring `run`); both resolve
 * the owner through completionRunOwnerOf.
 */
import { createCompletionRunContract, type CompletionRun } from '@bike4mind/common';
import { completionRunRepository } from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { completionRunOwnerOf } from '@server/completionRuns/callerCompletionRun';

export default nextRouteForContract(createCompletionRunContract, {
  rateLimit: perUserRateLimit('POST /api/v1/completion-runs'),
}).post(async (req, res) => {
  const run = await completionRunRepository.create({
    userId: req.user.id,
    ...completionRunOwnerOf({ userId: req.user.id, billingOrganizationId: req.apiKeyInfo?.organizationId }),
    apiKeyId: req.apiKeyInfo?.keyId,
    rootSessionId: req.validated.rootSessionId,
  });

  const body: CompletionRun = {
    runId: run.runId,
    ...(run.rootSessionId !== undefined && { rootSessionId: run.rootSessionId }),
    createdAt: run.createdAt.toISOString(),
  };
  return res.status(201).json(body);
});

export const config = {
  api: { externalResolver: true },
};
