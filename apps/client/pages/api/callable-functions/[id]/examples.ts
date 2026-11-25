import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import { setCallableFunctionExamples } from '@bike4mind/server-utils/callableFunctions/registry';
import {
  callableFunctionExamplesBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).put(
  perUserRateLimit('PUT /api/callable-functions/[id]/examples'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionExamplesBodySchema, req.body);
    res.json(await setCallableFunctionExamples(req.user, functionId(req.query), body.examples));
  }
);

export default handler;
