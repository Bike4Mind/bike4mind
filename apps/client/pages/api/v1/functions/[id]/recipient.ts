import { findFunctionRecipientContract } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  CALLABLE_FUNCTION_RECIPIENT_RATE_LIMIT,
  findCallableFunctionRecipient,
} from '@bike4mind/server-utils/callableFunctions/sharing';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { assertFunctionsEnabled } from '@server/callableFunctions/publicFunctions';

const handler = nextRouteForContract(findFunctionRecipientContract, {
  rateLimit: rateLimit(CALLABLE_FUNCTION_RECIPIENT_RATE_LIMIT),
}).get(async (req, res) => {
  await assertFunctionsEnabled(req.user);
  const person = await findCallableFunctionRecipient(req.user, req.validatedParams.id, req.validatedQuery.email);
  return res.json({ data: person });
});

export default handler;

export const config = {
  api: { externalResolver: true },
};
