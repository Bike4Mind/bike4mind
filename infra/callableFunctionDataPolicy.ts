import { callableFunctionDataBucket, callableFunctionDataPublicAccessBlock } from './callableFunctionData';
import { callableFunctionDataBucketPolicy } from './callableFunctionNetwork';
import { callableFunctionDataEndpointId } from './callableFunctionRuntime';
import { web } from './web';

// Separate from the bucket so the policy can name the web API function's role, which signs the runtime's read links.
// No server role under `sst dev`, so no policy there.
if (web.nodes.server && callableFunctionDataBucket && callableFunctionDataPublicAccessBlock) {
  const names = $util.all([
    callableFunctionDataBucket.arn,
    web.nodes.server.nodes.role.arn,
    callableFunctionDataEndpointId ?? '',
  ]);
  new aws.s3.BucketPolicy(
    'CallableFunctionDataPolicy',
    {
      bucket: callableFunctionDataBucket.bucket,
      policy: names.apply(([bucketArn, dispatcherRoleArn, endpointId]) =>
        JSON.stringify(callableFunctionDataBucketPolicy({ bucketArn, dispatcherRoleArn, endpointId }))
      ),
    },
    { dependsOn: [callableFunctionDataPublicAccessBlock] }
  );
}
