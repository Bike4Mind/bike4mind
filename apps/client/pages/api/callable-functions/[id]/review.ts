import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  reviewSharedCallableFunction,
  updateSharedCallableFunctionReview,
} from '@bike4mind/server-utils/callableFunctions/reviews';
import {
  callableFunctionReviewBodySchema,
  callableFunctionReviewSettingsBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

// Recipient only: a function not shared with the caller, their own included, reads as not found on every method.
const handler = baseApi({ auth: 'jwtOnly' })
  .put(perUserRateLimit('PUT /api/callable-functions/[id]/review'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionReviewBodySchema, req.body);
    res.json(await reviewSharedCallableFunction(req.user, functionId(req.query), body));
  })
  // Not gated, like stopping a share: with the setting off a recipient can still turn a function off or adjust it.
  .patch(perUserRateLimit('PATCH /api/callable-functions/[id]/review'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    const body = parseCallableFunctionBody(callableFunctionReviewSettingsBodySchema, req.body);
    res.json(await updateSharedCallableFunctionReview(req.user, functionId(req.query), body));
  });

export default handler;
