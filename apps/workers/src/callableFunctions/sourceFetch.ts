import {
  runCallableFunctionSourceFetchForLambda,
  type CallableFunctionSourceLambdaReply,
} from '@bike4mind/server-utils/callableFunctions/fetchSource';

// Lambda entry for callableFunctionSourceFetch (infra/callableFunctionSourceFetch.ts). Runs outside the VPC with no
// secrets linked: the dispatcher sends the URL and the listed origins, so this file stays free of the DB and Config.
export const handler = (event: unknown): Promise<CallableFunctionSourceLambdaReply> =>
  runCallableFunctionSourceFetchForLambda(event);
