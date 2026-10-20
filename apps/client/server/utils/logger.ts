import { Config } from '@bike4mind/server-utils/utils/config';
import { Context } from 'aws-lambda';
import { randomUUID } from 'crypto';

export const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Config.STAGE,
});
