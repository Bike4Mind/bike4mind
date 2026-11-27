import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';

// Fetches function data sources from admin-listed public origins, so no `vpc` and no `link`: no private route and no
// secrets. The dispatcher stores what it returns (packages/server-utils/src/callableFunctions/sources.ts).
export const callableFunctionSourceFetch = new sst.aws.Function('callableFunctionSourceFetch', {
  handler: 'apps/workers/src/callableFunctions/sourceFetch.handler',
  runtime: 'nodejs24.x',
  // Outlives the fetch's own 30 s ceiling; the dispatcher waits within its 45 s call budget.
  timeout: '40 seconds',
  memory: '512 MB',
  environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
});

/** The web API function's handle on it: the name to invoke and the grant to invoke it. */
export const callableFunctionSourceFetchForWeb = {
  environment: { CALLABLE_FUNCTION_SOURCE_FETCH_FUNCTION_NAME: callableFunctionSourceFetch.name },
  permissions: [{ actions: ['lambda:InvokeFunction'], resources: [callableFunctionSourceFetch.arn] }],
};
