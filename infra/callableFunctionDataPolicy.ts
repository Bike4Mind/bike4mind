import { callableFunctionDataBucket, callableFunctionDataPublicAccessBlock } from './callableFunctionData';
import { callableFunctionDataBucketPolicy } from './callableFunctionNetwork';
import { callableFunctionDataEndpointId } from './callableFunctionRuntime';
import { accountErasureQueueSubscription } from './queues';
import { web } from './web';

// Separate from the bucket so the policy can name the web API function's role, which signs the runtime's read links,
// and the account-erasure worker's, which purges an account's data. No server role under `sst dev`, so no policy there.
if (web.nodes.server && callableFunctionDataBucket && callableFunctionDataPublicAccessBlock) {
  const names = $util.all([
    callableFunctionDataBucket.arn,
    web.nodes.server.nodes.role.arn,
    accountErasureQueueSubscription.nodes.function.nodes.role.arn,
    callableFunctionDataEndpointId ?? '',
  ]);
  new aws.s3.BucketPolicy(
    'CallableFunctionDataPolicy',
    {
      bucket: callableFunctionDataBucket.bucket,
      policy: names.apply(([bucketArn, dispatcherRoleArn, eraserRoleArn, endpointId]) =>
        JSON.stringify(callableFunctionDataBucketPolicy({ bucketArn, dispatcherRoleArn, eraserRoleArn, endpointId }))
      ),
    },
    { dependsOn: [callableFunctionDataPublicAccessBlock] }
  );
}
