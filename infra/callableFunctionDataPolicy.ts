import {
  callableFunctionDataBrowserReaderRoleName,
  callableFunctionDataBucket,
  callableFunctionDataPublicAccessBlock,
} from './callableFunctionData';
import {
  callableFunctionDataBrowserReaderPolicy,
  callableFunctionDataBrowserReaderTrustPolicy,
  callableFunctionDataBucketPolicy,
} from './callableFunctionNetwork';
import { callableFunctionDataEndpointId } from './callableFunctionRuntime';
import { accountDeletionSweep } from './cron';
import { accountErasureQueueSubscription } from './queues';
import { web } from './web';

// Separate from the bucket so the policy can name the web API function's role, which signs the runtime's read links,
// and the roles that purge an account's data: the account-erasure worker's and, where it runs, the deletion sweep's.
// No server role under `sst dev`, so no policy there.
if (web.nodes.server && callableFunctionDataBucket && callableFunctionDataPublicAccessBlock) {
  // Signs the owner's browser links, the only signed links the bucket honors outside the runtime's endpoint.
  const browserReader = new aws.iam.Role('CallableFunctionDataBrowserReader', {
    name: callableFunctionDataBrowserReaderRoleName,
    assumeRolePolicy: web.nodes.server.nodes.role.arn.apply(arn =>
      JSON.stringify(callableFunctionDataBrowserReaderTrustPolicy(arn))
    ),
  });
  new aws.iam.RolePolicy('CallableFunctionDataBrowserReaderPolicy', {
    role: browserReader.name,
    policy: callableFunctionDataBucket.arn.apply(arn => JSON.stringify(callableFunctionDataBrowserReaderPolicy(arn))),
  });
  const names = $util.all([
    callableFunctionDataBucket.arn,
    web.nodes.server.nodes.role.arn,
    browserReader.arn,
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
      policy: names.apply(([bucketArn, dispatcherRoleArn, browserReaderRoleArn, eraserRoleArns, endpointId]) =>
        JSON.stringify(
          callableFunctionDataBucketPolicy({
            bucketArn,
            dispatcherRoleArn,
            browserReaderRoleArn,
            eraserRoleArns,
            endpointId,
          })
        )
      ),
    },
    { dependsOn: [callableFunctionDataPublicAccessBlock] }
  );
}
