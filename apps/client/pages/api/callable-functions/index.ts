import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  assertCallableFunctionsEnabled,
  resolveCallableFunctionsEnabled,
} from '@bike4mind/server-utils/callableFunctions/access';
import { createCallableFunction, listCallableFunctions } from '@bike4mind/server-utils/callableFunctions/registry';
import {
  callableFunctionCreateBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

// Session-only (`jwtOnly`): these are not public API routes and have no contract.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(perUserRateLimit('GET /api/callable-functions'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    // With the setting off there is nothing to show, as for custom connections.
    if (!(await resolveCallableFunctionsEnabled(req.user))) return res.json([]);
    const artifactId = typeof req.query.artifactId === 'string' ? req.query.artifactId : undefined;
    res.json(await listCallableFunctions(req.user, { artifactId }));
  })
  .post(perUserRateLimit('POST /api/callable-functions'), async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionCreateBodySchema, req.body);
    res.status(201).json(await createCallableFunction(req.user, body));
  });

export default handler;
