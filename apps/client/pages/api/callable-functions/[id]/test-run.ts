import { UnauthorizedError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { assertCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';
import {
  callableFunctionTestRunBudget,
  runCallableFunctionTests,
} from '@bike4mind/server-utils/callableFunctions/testRun';
import {
  callableFunctionTestRunBodySchema,
  parseCallableFunctionBody,
} from '@server/validators/callableFunctionValidators';

export type {
  CallableFunctionTestCaseResult,
  CallableFunctionTestRun,
} from '@bike4mind/server-utils/callableFunctions/testRun';

const functionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' }).post(
  perUserRateLimit('POST /api/callable-functions/[id]/test-run'),
  async (req, res) => {
    if (!req.user) throw new UnauthorizedError('Sign in to use callable functions.');
    await assertCallableFunctionsEnabled(req.user);
    const body = parseCallableFunctionBody(callableFunctionTestRunBodySchema, req.body ?? {});
    res.json(
      await runCallableFunctionTests(req.user, functionId(req.query), {
        ...(body.tests ? { tests: body.tests } : {}),
        budgetMs: callableFunctionTestRunBudget(),
      })
    );
  }
);

export default handler;
