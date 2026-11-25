import { callableFunctionDataBucket, callableFunctionDataPublicAccessBlock } from './callableFunctionData';
import { callableFunctionDataBucketPolicy } from './callableFunctionNetwork';
import { callableFunctionDataEndpointId } from './callableFunctionRuntime';
import { accountDeletionSweep } from './cron';
import { accountErasureQueueSubscription } from './queues';
import { web } from './web';

// Separate from the bucket so the policy can name the web API function's role, which signs the runtime's read links,
// and the roles that purge an account's data: the account-erasure worker's and, where it runs, the deletion sweep's.
// No server role under `sst dev`, so no policy there.
if (web.nodes.server && callableFunctionDataBucket && callableFunctionDataPublicAccessBlock) {
  const names = $util.all([
    callableFunctionDataBucket.arn,
    web.nodes.server.nodes.role.arn,
    $util.all([
      accountErasureQueueSubscription.nodes.function.nodes.role.arn,
      accountDeletionSweep?.nodes.function.nodes.role.arn ?? '',
    ]),
    callableFunctionDataEndpointId ?? '',
  ]);
  new aws.s3.BucketPolicy(
    'CallableFunctionDataPolicy',
    {
      bucket: callableFunctionDataBucket.bucket,
      policy: names.apply(([bucketArn, dispatcherRoleArn, eraserRoleArns, endpointId]) =>
        JSON.stringify(callableFunctionDataBucketPolicy({ bucketArn, dispatcherRoleArn, eraserRoleArns, endpointId }))
      ),
    },
    { dependsOn: [callableFunctionDataPublicAccessBlock] }
  );
}
