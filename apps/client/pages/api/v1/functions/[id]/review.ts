import { NotFoundError, reviewFunctionContract } from '@bike4mind/common';
import {
  reviewSharedCallableFunction,
  updateSharedCallableFunctionReview,
} from '@bike4mind/server-utils/callableFunctions/reviews';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import {
  FUNCTION_NOT_FOUND_MESSAGE,
  assertFunctionsEnabled,
  functionsRateLimit,
  resolveCallableFunction,
  toPublicFunctionDetail,
} from '@server/callableFunctions/publicFunctions';

// The review service the app's pages/api/callable-functions/[id]/review route calls; it checks the share again.
const handler = nextRouteForContract(reviewFunctionContract, {
  rateLimit: functionsRateLimit('/api/v1/functions/[id]/review'),
}).post(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const { id } = req.validatedParams;
  const entry = await resolveCallableFunction(req.user, id);
  if (entry.access === 'owner') throw new NotFoundError(FUNCTION_NOT_FOUND_MESSAGE);

  const body = req.validated;
  if (body.action === 'allow') {
    await reviewSharedCallableFunction(req.user, entry.fn.id, {
      reviewHash: body.review_hash,
      approval: entry.approval,
    });
  } else {
    await updateSharedCallableFunctionReview(req.user, entry.fn.id, { enabled: false });
  }
  return res.json({ data: await toPublicFunctionDetail(await resolveCallableFunction(req.user, id)) });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
